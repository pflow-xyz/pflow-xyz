// The nets the layout benchmark runs over: the bundled examples plus the
// 3-barista coffee shop. Normalises array-style files to the editor's dict model.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function normalise(d, name) {
    const dict = (x) => {
        if (Array.isArray(x)) return Object.fromEntries(x.map(o => [o.id, { ...o }]));
        return Object.fromEntries(Object.entries(x || {}).map(([k, v]) => [k, { ...v }]));
    };
    const arcs = (d.arcs || []).map(a => ({ source: a.source ?? a.from, target: a.target ?? a.to, ...(a.inhibit ? { inhibit: true } : {}) }));
    return { name, places: dict(d.places), transitions: dict(d.transitions), arcs };
}

export function loadNets(root = '.') {
    const nets = [];
    const coffee = JSON.parse(readFileSync(join(root, 'parity/layout/coffee-shop.json'), 'utf8'));
    nets.push(normalise(coffee, 'coffee-shop'));
    for (const f of readdirSync(join(root, 'examples')).sort()) {
        if (f.endsWith('.jsonld')) {
            const d = JSON.parse(readFileSync(join(root, 'examples', f), 'utf8'));
            if (d.transitions) nets.push(normalise(d, 'jsonld-' + f.slice(8, 14)));
        }
    }
    for (const f of ['cafe-order', 'cafe-service', 'cafe-kinetics', 'cafe-market']) {
        const d = JSON.parse(readFileSync(join(root, 'examples/showcase', f + '.json'), 'utf8'));
        nets.push(normalise(d, f));
    }
    return nets.filter(n => Object.keys(n.places).length + Object.keys(n.transitions).length > 0);
}
