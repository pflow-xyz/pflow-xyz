// node scripts/layout-bench.mjs [--write]   before/after table for the layout algorithms.
import { writeFileSync } from 'node:fs';
import { loadNets } from '../parity/layout/nets.mjs';
import { legacyLayout } from '../parity/layout/legacy.mjs';
import { layoutNet, measure, score } from '../public/petri-layout.js';

const ALGOS = ['sugiyama', 'grid', 'bipartite', 'circular', 'string', 'auto'];
const nets = loadNets('.');
const rows = [];
const baseline = {};
for (const net of nets) {
    for (const algo of ALGOS) {
        const after = layoutNet(net, algo);
        const again = layoutNet(net, algo);
        const det = JSON.stringify(after.positions) === JSON.stringify(again.positions);
        const a = measure(net, after.positions);
        let b = null;
        if (algo !== 'auto') { try { b = measure(net, legacyLayout(net, algo)); } catch (e) { b = null; } }
        rows.push({ net: net.name, algo, a, b, det, chosen: after.chosen });
        baseline[net.name + '/' + algo] = { ...a, det };
    }
}
const f = (m) => m ? `x${m.crossings} o${m.overlaps} n${m.throughNodes} l${m.throughLabels} len${m.length} ar${m.aspect}` : '-';
console.log('net'.padEnd(18), 'algo'.padEnd(10), 'BEFORE'.padEnd(34), 'AFTER'.padEnd(34), 'score b->a', 'det');
for (const r of rows) {
    console.log(r.net.padEnd(18), r.algo.padEnd(10), f(r.b).padEnd(34), f(r.a).padEnd(34),
        (r.b ? score(r.b).toFixed(0) : '-') + '->' + score(r.a).toFixed(0), r.det ? 'ok' : 'NONDET', r.chosen || '');
}
const sum = {};
for (const r of rows) {
    const s = sum[r.algo] ||= { b: 0, a: 0, bx: 0, ax: 0, bo: 0, ao: 0, bt: 0, at: 0 };
    if (r.b) { s.b += score(r.b); s.bx += r.b.crossings; s.bo += r.b.overlaps; s.bt += r.b.throughNodes + r.b.throughLabels; }
    s.a += score(r.a); s.ax += r.a.crossings; s.ao += r.a.overlaps; s.at += r.a.throughNodes + r.a.throughLabels;
}
console.log('\nper algorithm (summed over nets): score, crossings, overlaps, arcs-through-nodes/labels');
for (const [k, s] of Object.entries(sum)) console.log(k.padEnd(10), k === 'auto' ? '' : `before ${s.b.toFixed(0)} x${s.bx} o${s.bo} t${s.bt}`, `| after ${s.a.toFixed(0)} x${s.ax} o${s.ao} t${s.at}`);
if (process.argv.includes('--write')) {
    writeFileSync('parity/layout/baseline.json', JSON.stringify(baseline, null, 1) + '\n');
    console.log('wrote parity/layout/baseline.json');
}
