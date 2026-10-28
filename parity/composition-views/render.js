// Render one composition view headless and return its scene manifest: the
// web half of the parity contract (pflow-native docs/composition-views-scene.md).
// The state is reached by registry commands only, from a fresh session, as the
// contract's table says; the view then draws into a minimal DOM (vdom.js) and
// collects its manifest while it draws.

import { installDom } from './vdom.js';
import * as registry from '../../public/compose/registry.js';
import { loadFacts } from '../../public/compose/model.js';
import { state, start } from '../../public/compose/state.js';
import { makeCtx, VIEW_IDS } from '../../public/compose/ctx.js';
import { makeManifest } from '../../public/compose/manifest.js';

// The contract's states: commands after `bundle.open {}` and `plan.open {}`.
export const STATES = {
  default: [],
  'payment2-pushout': [
    ['bundle.add_instance', { id: 'payment2' }],
    ['bundle.add_link', { kind: 'token', from: 'payment:account:customer', to: 'payment2:account:customer' }],
  ],
  'no-links': [['bundle.clear_links', {}]],
  'release-undo': [['bundle.add_link', { kind: 'event', from: 'payment:undo:reserve', to: 'workers:release' }]],
  'plan-threats': [['plan.add_piece', { piece: 'threats', slot: 'order' }]],
};
export const EXAMPLES = ['orders', 'connect4'];
export { VIEW_IDS };

let views = null;
let connect4 = null;

/** Load the wasm (from the vendored gzip), the facts and the views, once. */
export async function setup() {
  if (views) return;
  if (typeof Deno === 'undefined') throw new Error('parity/composition-views runs under deno');
  const gz = await Deno.readFile(new URL('../../public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz', import.meta.url));
  const bytes = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  installDom();
  await registry.init({ bytes });
  loadFacts();
  connect4 = JSON.parse(await Deno.readTextFile(new URL('../../public/compose/assets/connect-4.json', import.meta.url)));
  views = {};
  for (const id of VIEW_IDS) {
    try { views[id] = (await import(`../../public/compose/views/${id}.js`)).default; } catch (e) { views[id] = { broken: e, render() { throw e; } }; }
  }
}

/**
 * Reach `stateId` by commands on the live engine, render `view` for `example`,
 * and return {manifest, conflicts, root}.
 */
export async function renderManifest(view, example, stateId) {
  await setup();
  start({ steps: STATES[stateId] });
  state.example = example;
  state.view = view;
  const root = installDom().createElement('div');
  globalThis.document.body.appendChild(root);
  const manifest = makeManifest(view, example, stateId);
  const noop = () => {};
  const ctx = makeCtx(root, {
    snap: { port: noop, slot: noop, piece: noop },
    hover: noop,
    manifest,
    connect4,
    rerender: noop,
  });
  ctx.headless = true;
  views[view].render(ctx);
  // A view that loads something first (laws: the Chyp results) draws once it has it.
  if (views[view].ready) { await views[view].ready(ctx); }
  return { manifest: manifest.result(), conflicts: manifest.conflicts, root };
}
