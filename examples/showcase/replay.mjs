// Replay fixtures/firing-sequence.json against cafe.jsonld with petri-sim.js,
// the same pure functions the pflow.xyz editor's play mode uses. The third
// step (close while brewing) must be BLOCKED by the inhibitor arc.
//   node examples/showcase/replay.mjs     (from the pflow-xyz repo root)
import { enabledTransitions, fire, marking } from '../../public/petri-sim.js';
import { expandColors, colorCount } from '../../public/petri-colors.js';
import { fromJSON } from '../../public/petri-solver.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(here, 'cafe.jsonld'), 'utf8'));
const seq = JSON.parse(readFileSync(join(here, 'fixtures/firing-sequence.json'), 'utf8'));
const net = fromJSON(model);
console.log(`colors=${colorCount(net)} expanded places=${expandColors(net).net.places.size}`);
let state = marking(model);
console.log('enabled at start:', enabledTransitions(model, state).join(' '));
let blocked = 0;
for (const t of seq) {
  const next = fire(model, t, state);
  console.log(t.padEnd(15), next ? 'fired  ' : 'BLOCKED', next ? JSON.stringify({ queue: next.queue[0], pantry: next.pantry, brewing: next.brewing[0], open: next.open[0] }) : '');
  if (next) state = next; else blocked++;
}
console.log('enabled at end:', enabledTransitions(model, state).join(' '));
if (blocked !== 1) { console.error(`expected exactly one blocked firing, saw ${blocked}`); process.exit(1); }
