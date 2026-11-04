#!/usr/bin/env node
// Record the curated views behind the landing page's example cards (docs/design/agent-first-analysis.md
// section 16.3, steps H3 and H4), with no model.
//
//   node scripts/record-example-views.mjs           run each example's plan and write public/examples.json
//   node scripts/record-example-views.mjs --check   record again and fail if public/examples.json differs
//
// For each card: the net's file (examples/landing/<name>.jsonld, fetched from https://pflow.xyz/o/<cid> and kept
// byte for byte; its sha256 is pinned in examples.json), the goal's plan run headless on a sandbox through the
// engine guard (the same runGoal the Ask uses), the calls that ran with every argument resolved, the engine
// versions, and the digest of every artifact. That is a ViewSpec; a card opens it with
// /?cid=<cid>#view=<payload> (scripts/gen-example-cards.mjs writes the payload into public/index.html).
//
// Each card's "Opens to" line is an editorial claim about the model, so it is not typed here: it is built from
// what the result shows (opens() below reads the artifacts and the engine's report), and a result that does not
// support its claim stops the recording instead of shipping the claim. public/examples_test.ts replays every
// spec on every `make test-js`, so an engine change that alters a view fails the build and is reviewed.
//
// Deviations from the design's pairing (16.3), each checked against what the engine says; see PLAN below.
// The node: modules are imported by a computed specifier, as scripts/sync-native-wasm.mjs does: a literal one makes Deno
// want @types/node to type-check, and public/examples_test.ts imports this file.
const { createHash } = await import(`node:${'crypto'}`);
const { readFileSync, writeFileSync } = await import(`node:${'fs'}`);
const { gunzipSync } = await import(`node:${'zlib'}`);
const { fileURLToPath } = await import(`node:${'url'}`);

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`);

const n = (x) => Number(x).toLocaleString('en-US');
const sig = (x, d = 2) => String(+Number(x).toPrecision(d));

/**
 * The cards, in page order. `goal` is a catalog goal (public/goals.json); `ode` swaps the goal's engine branch for
 * the ODE (see the note on colour). `opens(f)` reads the result and returns the "Opens to" sentence.
 *
 * What the engine said when each design pairing was tried (the evidence for the choices below):
 *
 *   Coffee Shop      design: conserved. analysis.invariants finds NO place invariant (p_invariants: [], none of the
 *                    four places covered): restocking and arrivals add tokens, so nothing is conserved and the
 *                    view would open to two empty tables. Recorded instead: stuck, which the engine PROVES
 *                    (exhaustive over every reachable state).
 *   Tic-Tac-Toe      design: best_play. Holds: game.move, exact, value 0. It is one report (a draw, one move), not a
 *                    heatmap; the line says so.
 *   Enzyme Kinetics  design: average. The guard routes the goal to the SSA (60 tokens), but sim.ssa reads only the
 *                    FIRST colour of each place and this net has four (S, E, C, P are one colour each): the SSA
 *                    runs with E, C and P at 0 and drains S through a zero-weight arc (S 50 -> 19.3 with no
 *                    enzyme). Recorded: the ODE branch of the same goal, which unfolds colours (the design asks
 *                    for an ODE trajectory here too). The guard's caution for the ODE on 60 tokens is shown on open.
 *   Predator-Prey    design: a phase portrait. No registry command draws one (a phase plot is a way to render a
 *                    time series). The same colour problem rules out the SSA (it starts the predators at 0).
 *                    Recorded: the ODE trajectories, and the line says they are not a phase portrait.
 *   Producer-Consumer design: unbounded. Holds: bounded is proved over all 10 reachable states.
 *   USDC Bridge      design: stuck. analysis.verify answers "unknown": the search stops at 1 state because the
 *                    4,000,000-token marking is past its 1,000-token cap. Recorded instead: conserved, which the
 *                    engine proves structurally (all five places sum to 4,000,000).
 */
export const PLAN = [
    {
        id: 'coffee-shop', title: 'Coffee Shop', file: 'coffee-shop.jsonld', cid: 'z4EBG9j3NhEnaxZBEpXXCvyMbR9utkgUZoPBQFxS99qSehUwuBL',
        blurb: 'Weighted arcs encode recipes, conservation laws guarantee you never oversell a latte.',
        goal: 'stuck', inputs: {},
        opens(f) {
            const v = f.step('analysis.verify').result.verdicts[0];
            need(v.status === 'proved' && v.method === 'exhaustive', 'coffee-shop: stuck is not proved exhaustively', v);
            return `it cannot get stuck: no deadlock in any of the ${n(f.step('analysis.verify').result.state_count)} reachable states`;
        },
    },
    {
        id: 'tic-tac-toe', title: 'Tic-Tac-Toe', file: 'tic-tac-toe.jsonld', cid: 'z4EBG9j1YQFZEQBpCn3ZjdpAuXpPnrKSDF5YXsW3q86znPztEoh',
        blurb: 'Every board position is a place. ODE heatmaps reveal optimal play from network topology alone.',
        goal: 'best_play',
        inputs: { sides: '{"x_": 1, "o_": -1}', reward: '{"win_x": 1, "win_o": -1}', auto: '["x_win_", "o_win_"]' },
        opens(f) {
            const m = f.step('game.move').result;
            need(m.exact === true && Number.isFinite(m.value), 'tic-tac-toe: game.move is not an exact value', m);
            const who = m.value === 0 ? 'a draw' : m.value > 0 ? 'a win for X' : 'a win for O';
            return `best play ends in ${who}: exact search over ${n(m.nodes)} positions (a best-move report, not a heatmap)`;
        },
    },
    {
        id: 'enzyme-kinetics', title: 'Enzyme Kinetics', file: 'enzyme-kinetics.jsonld', cid: 'z4EBG9j1aMiBny6hgTAKFXfXxTASCD5vT6NVY3opfQx4FfBf42a',
        blurb: 'Four places, three transitions — mass-action kinetics produce Michaelis-Menten curves automatically.',
        goal: 'average', ode: true, inputs: {},
        opens(f) {
            const s = series(f.artifact('sim.ode'));
            const c = peak(s.C, s.x);
            return `substrate turning into product (ODE): the complex C peaks at ${sig(c.y)} near t = ${sig(c.x, 1)}; by t = ${sig(s.x.at(-1), 2)}, P is ${sig(s.P.at(-1))} and S has fallen from ${sig(s.S[0])} to ${sig(s.S.at(-1), 2)}`;
        },
    },
    {
        id: 'predator-prey', title: 'Predator-Prey', file: 'predator-prey.jsonld', cid: 'z4EBG9j7s3ri1DFxbBYpxYUhKtZf8ngA3nfw9849upqeQj85z9J',
        blurb: 'Lotka-Volterra dynamics — two species, three reactions, and the ODE solver draws the phase portrait.',
        goal: 'average', ode: true, inputs: {},
        opens(f) {
            const s = series(f.artifact('sim.ode'));
            const p = peak(s.Predator, s.x);
            return `ODE trajectories, not a phase portrait: predators peak at ${sig(p.y)} near t = ${sig(p.x, 1)} while prey fall from ${sig(s.Prey[0])} to almost none`;
        },
    },
    {
        id: 'producer-consumer', title: 'Producer-Consumer', file: 'producer-consumer.jsonld', cid: 'z4EBG9jDW9ike1veSLWu9Et2dMTiPEWTMkai8TkjUtEaUVtyrda',
        blurb: 'Bounded buffer concurrency — capacity constraints prevent overflow, token counts prove correctness.',
        goal: 'unbounded', inputs: {},
        opens(f) {
            const v = f.step('analysis.verify').result.verdicts[0];
            need(v.status === 'proved' && v.method === 'exhaustive', 'producer-consumer: bounded is not proved exhaustively', v);
            const top = f.step('analysis.reachability').result.max_tokens.buffer;
            return `the buffer never holds more than ${n(top)}: bounded is proved across all ${n(f.step('analysis.verify').result.state_count)} reachable states`;
        },
    },
    {
        id: 'usdc-bridge', title: 'USDC Bridge', file: 'usdc-bridge.jsonld', cid: 'z4EBG9jC6HtPfeMtyA5yt6HuzDspMH2B15FQZ7mx3D2zeBwBU1f',
        blurb: 'Cross-chain token flow — IBC to Noble, CCTP burn-and-mint to Base, all as one net.',
        goal: 'conserved', inputs: {},
        opens(f) {
            const r = f.step('analysis.invariants').result;
            need(r.p_covered === true && r.p_invariants.length === 1, 'usdc-bridge: no single covering place invariant', r);
            const inv = r.p_invariants[0];
            return `no USDC is created or lost in transit: all ${inv.nodes.length} places always sum to ${n(inv.value)}`;
        },
    },
];

function need(ok, msg, detail) {
    if (!ok) throw new Error(`${msg}: ${JSON.stringify(detail).slice(0, 300)}`);
}

// A timeseries artifact as {x, <place>: values}.
function series(art) {
    need(art?.data?.kind === 'timeseries', 'expected a timeseries artifact', art?.data?.kind);
    const out = { x: art.data.x };
    for (const s of art.data.series) out[s.name] = s.values;
    return out;
}
const peak = (ys, xs) => { const i = ys.indexOf(Math.max(...ys)); return { x: xs[i], y: ys[i] }; };

// Deep equality of two JSON values, whatever the key order.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const same = (a, b) => canon(a) === canon(b);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function loadModules() {
    const wasm = await import('../public/petri-wasm.js');
    const bytes = gunzipSync(read('public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz'));
    await wasm.loadEngine({ bytes, storage: null });
    const [commands, goals, provenance, viewspec] = await Promise.all([
        import('../public/petri-commands.js'), import('../public/petri-goals.js'),
        import('../public/petri-provenance.js'), import('../public/petri-viewspec.js'),
    ]);
    return { commands, goals, provenance, viewspec };
}

/** Record every card. Returns the examples.json object. */
export async function record() {
    const { commands: C, goals: G, provenance: P, viewspec: V } = await loadModules();
    const catalog = JSON.parse(read('public/goals.json').toString('utf8'));
    const versions = P.defaultVersions();
    let previous = [];
    try { previous = JSON.parse(read('public/examples.json').toString('utf8')).examples || []; } catch { /* the first recording */ }
    const examples = [];
    for (const ex of PLAN) {
        const bytes = read(`examples/landing/${ex.file}`);
        const model = JSON.parse(bytes.toString('utf8'));
        need(model['@id'] === ex.cid, `${ex.id}: the file's @id is not the card's CID`, model['@id']);
        const base = catalog.goals.find((g) => g.id === ex.goal);
        need(base, `${ex.id}: no goal ${ex.goal}`, ex.goal);
        // The goal's own ODE branch (average: recommend, then sim.ode over the recommended horizon), with the `when` taken off:
        // the guard still looks at it and carries its caution, which is how the footer will say "ODE on a net where the engine
        // recommends SSA". See the note on colour in PLAN.
        const goal = ex.ode ? { ...base, plan: [base.plan[0], { command: 'sim.ode', args: { t_end: '$step0.t_end' } }] } : base;

        const live = new C.Registry(C.createHeadlessHost(model));
        const out = await G.runGoal(live, goal, ex.inputs);
        need(out.ok, `${ex.id}: the plan did not run`, out.steps.find((s) => s.error));
        need(!out.steps.some((s) => s.refused), `${ex.id}: the guard refused a step`, out.steps);
        const record = P.recordFromGoalRun(goal, out, { inputs: ex.inputs, net: { cid: ex.cid, revision: 0 }, versions });
        const f = {
            step: (command) => out.steps.find((s) => s.command === command && s.result),
            artifact: (command) => {
                const s = out.steps.find((x) => x.command === command && x.artifacts?.length);
                return live.artifacts().find((a) => a.id === s.artifacts[0]);
            },
        };
        const opensTo = ex.opens(f);

        // The spec, replayed on a fresh sandbox (the way an opener runs it) to take the digests; and again to prove them.
        const draft = V.buildViewSpec({ net: ex.cid, view: ex.goal, calls: record.calls, engine: versions });
        const first = await V.replayViewSpec(draft, V.sandboxRegistry(model), { versions });
        need(first.ok && !first.errors.length, `${ex.id}: the spec did not replay`, first.errors);
        const spec = { ...draft, expect: await V.expectFor(first.artifactData) };
        const again = await V.replayViewSpec(spec, V.sandboxRegistry(model), { versions });
        need(again.ok && again.drift.matched.length === spec.expect.artifacts.length && !again.drift.differed.length, `${ex.id}: the digests do not reproduce`, again.drift);
        const check = V.validateViewSpec(spec, V.sandboxRegistry(model), { model });
        need(check.ok, `${ex.id}: the spec does not validate`, check);

        // The card's #view= value. Compressed bytes are not canonical (Node's deflate and Deno's differ), so a payload that
        // already decodes to this spec is kept: the cards do not churn when this runs under another runtime.
        const kept = previous.find((p) => p.id === ex.id)?.payload;
        const payload = kept && same((await V.decodeView(kept, { net: ex.cid })).spec, spec) ? kept : await V.encodeView(spec);

        examples.push({
            id: ex.id, title: ex.title, cid: ex.cid, file: `examples/landing/${ex.file}`, sha256: sha256(bytes),
            blurb: ex.blurb, opensTo, goal: ex.goal, spec, payload,
        });
    }
    return {
        generatedBy: 'node scripts/record-example-views.mjs',
        about: 'The curated view behind each landing-page example card. Do not edit by hand: re-record, and review every opensTo line, which is an editorial claim about the model.',
        examples,
    };
}

const text = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
    const recorded = text(await record());
    const path = `${ROOT}public/examples.json`;
    if (process.argv.includes('--check')) {
        let have = '';
        try { have = readFileSync(path, 'utf8'); } catch { /* none yet */ }
        if (have !== recorded) { console.error('public/examples.json is out of date: run node scripts/record-example-views.mjs and review the diff'); process.exit(1); }
        console.log('public/examples.json matches a fresh recording');
    } else {
        writeFileSync(path, recorded);
        console.log(`wrote public/examples.json (${PLAN.length} examples)`);
        for (const e of JSON.parse(recorded).examples) console.log(`  ${e.id}: Opens to: ${e.opensTo}`);
    }
}
