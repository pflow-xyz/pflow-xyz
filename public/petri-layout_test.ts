// Layout regression tests: the metrics of every algorithm on every bundled net
// must not get worse than parity/layout/baseline.json (regenerate deliberately
// with `node scripts/layout-bench.mjs --write`), and the new Sugiyama must beat
// the layout it replaced.
import { assert, assertEquals } from 'jsr:@std/assert';
import { layoutNet, measure, score, ALGOS } from './petri-layout.js';

const root = new URL('../', import.meta.url);
const read = (p: string) => JSON.parse(Deno.readTextFileSync(new URL(p, root)));

function dict(x: any) {
    if (Array.isArray(x)) return Object.fromEntries(x.map((o: any) => [o.id, { ...o }]));
    return Object.fromEntries(Object.entries(x || {}).map(([k, v]: any) => [k, { ...v }]));
}
function norm(d: any, name: string) {
    return { name, places: dict(d.places), transitions: dict(d.transitions),
        arcs: (d.arcs || []).map((a: any) => ({ source: a.source ?? a.from, target: a.target ?? a.to })) };
}
function nets() {
    const out = [norm(read('parity/layout/coffee-shop.json'), 'coffee-shop')];
    for (const e of Deno.readDirSync(new URL('examples/', root))) {
        if (e.name.endsWith('.jsonld')) {
            const d = read('examples/' + e.name);
            if (d.transitions) out.push(norm(d, 'jsonld-' + e.name.slice(8, 14)));
        }
    }
    for (const f of ['cafe-order', 'cafe-service', 'cafe-kinetics', 'cafe-market']) out.push(norm(read(`examples/showcase/${f}.json`), f));
    return out;
}
const baseline = read('parity/layout/baseline.json');

Deno.test('layout: deterministic and no worse than the recorded baseline', () => {
    for (const net of nets()) {
        for (const algo of ALGOS) {
            const a = layoutNet(net, algo), b = layoutNet(net, algo);
            assertEquals(JSON.stringify(a.positions), JSON.stringify(b.positions), `${net.name}/${algo} not deterministic`);
            const ids = Object.keys({ ...net.places, ...net.transitions });
            assertEquals(Object.keys(a.positions).sort(), ids.sort(), `${net.name}/${algo} must position every node`);
            const m: any = measure(net, a.positions), base = baseline[`${net.name}/${algo}`];
            assert(base, `no baseline for ${net.name}/${algo}`);
            for (const k of ['crossings', 'overlaps', 'throughNodes', 'throughLabels']) {
                assert(m[k] <= base[k], `${net.name}/${algo}: ${k} regressed ${base[k]} -> ${m[k]}`);
            }
            assert(m.length <= base.length * 1.02, `${net.name}/${algo}: arc length regressed ${base.length} -> ${m.length}`);
        }
    }
});

Deno.test('layout: sugiyama puts workflow sources on top, sinks at the bottom, resources beside the cycle', () => {
    const net = nets()[0];
    const p = layoutNet(net, 'sugiyama').positions;
    assertEquals(measure(net, p).crossings, 0);
    assertEquals(measure(net, p).overlaps, 0);
    assert(p.customer_arrives.y === Math.min(...Object.values(p).map((q: any) => q.y)), 'entry transition is the top row');
    const maxY = Math.max(...Object.values(p).map((q: any) => q.y));
    assertEquals(p.served.y, maxY);
    assertEquals(p.abandoned.y, maxY);
    // baristas_free shares a row with the queue, not the bottom
    assertEquals(p.baristas_free.y, p.queue.y);
    assert(p.baristas_free.x !== p.queue.x);
});

Deno.test('layout: auto never scores worse than sugiyama', () => {
    for (const net of nets()) {
        const auto = score(measure(net, layoutNet(net, 'auto').positions));
        const sug = score(measure(net, layoutNet(net, 'sugiyama').positions));
        assert(auto <= sug + 1e-9, `${net.name}: auto ${auto} > sugiyama ${sug}`);
    }
});

Deno.test('layout: empty and single-node nets', () => {
    for (const algo of ALGOS) {
        assertEquals(layoutNet({ places: {}, transitions: {}, arcs: [] }, algo).positions, {});
        const one = layoutNet({ places: { a: {} }, transitions: {}, arcs: [] }, algo).positions;
        assertEquals(Object.keys(one), ['a']);
    }
});
