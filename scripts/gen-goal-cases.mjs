// gen-goal-cases.mjs — fill the `nets` section of parity/ask/goal-cases.json,
// the eval set for the goal toolset (docs/design/agent-first-analysis.md,
// Step 2), from the fixture files it names:
//
//   engine  what sim.recommend says for the net (the engine the plan will
//           use; the model must not choose it); copied onto every case
//   info    the net.info summary the Assistant sends as `net` on every turn,
//           so the live eval (cmd/webserver/llm_goal_eval_test.go) sends what
//           the editor would, without a JS engine
//
// `cases` is hand-written and left as it is. public/petri-tools_test.ts fails
// when `nets` is out of date, so a changed fixture, net.info or recommend
// rule means running this again:
//
//   node scripts/gen-goal-cases.mjs
//
// A net's `format` is "sim" for the parity/ssa files, which are written in
// sim.pflow.xyz's model shape (places and transitions as lists, arcs as
// from/to); loadNet() turns those into the editor's shape. Anything else is
// already the editor's JSON-LD.
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { Registry, createHeadlessHost } from '../public/petri-commands.js';
import { loadEngine } from '../public/petri-wasm.js';

const root = new URL('../', import.meta.url);
const file = new URL('parity/ask/goal-cases.json', root);

/** sim.pflow.xyz's model shape → the editor's (no read arcs, delays or kinetic flags: the parity/ssa files used here have none). */
export function simToEditor(m) {
    const places = {}, transitions = {};
    for (const p of m.places) places[p.id] = { initial: [p.initial || 0], capacity: [p.capacity || 0], x: 0, y: 0 };
    for (const t of m.transitions) transitions[t.id] = { x: 0, y: 0, ...(t.rate !== undefined ? { rate: t.rate } : {}) };
    const arcs = m.arcs.map((a) => {
        if (a.type && a.type !== 'inhibitor') throw new Error(`arc ${a.from} -> ${a.to}: type ${a.type} has no editor form here`);
        return { source: a.from, target: a.to, weight: [a.weight || 1], ...(a.type === 'inhibitor' ? { inhibit: true } : {}) };
    });
    return { name: m.name, places, transitions, arcs };
}

export function loadNet(entry) {
    const doc = JSON.parse(readFileSync(new URL(entry.file, root), 'utf8'));
    return entry.format === 'sim' ? simToEditor(doc.model) : doc;
}

/** The layout the file keeps: one line for each net (its info is large) and each case. */
export function serialize(doc) {
    const { nets, cases, ...head } = doc;
    const entry = (k, v) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`;
    return '{\n'
        + Object.entries(head).map(([k, v]) => `  ${entry(k, v)},\n`).join('')
        + '  "nets": {\n' + Object.entries(nets).map(([k, v]) => `    ${entry(k, v)}`).join(',\n') + '\n  },\n'
        + '  "cases": [\n' + cases.map((c) => `    ${JSON.stringify(c)}`).join(',\n') + '\n  ]\n}\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const gz = readFileSync(new URL('public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz', root));
    await loadEngine({ bytes: new Uint8Array(gunzipSync(gz)) });
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    for (const [name, entry] of Object.entries(doc.nets)) {
        const r = new Registry(createHeadlessHost(loadNet(entry)));
        entry.engine = (await r.execute('sim.recommend')).engine;
        entry.info = JSON.parse(JSON.stringify(await r.execute('net.info')));
        console.log(`${name}: ${entry.file} -> ${entry.engine}, ${entry.info.places.length} places, ${entry.info.transitions.length} transitions`);
    }
    for (const c of doc.cases) {
        if (!doc.nets[c.net]) throw new Error(`${c.id}: no net ${c.net}`);
        c.engine = doc.nets[c.net].engine;
    }
    writeFileSync(file, serialize(doc));
    console.log(`${file.pathname}: ${doc.cases.length} cases on ${Object.keys(doc.nets).length} nets`);
}
