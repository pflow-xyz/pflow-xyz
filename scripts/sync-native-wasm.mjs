// sync-native-wasm.mjs — vendor pflow-native's wasm shim into public/vendor/pflow-native-wasm/.
//
//   node scripts/sync-native-wasm.mjs --from ../pflow-native/target/wasm-shim --commit <sha> [--to public/vendor/pflow-native-wasm]
//
// Build the shim first in pflow-native: `make wasm-shim` (size-optimised:
// CARGO_PROFILE_RELEASE_OPT_LEVEL=z CARGO_PROFILE_RELEASE_LTO=true
// CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1). This script:
//
//   - copies the wasm-bindgen glue (pflow_native_wasm.js) as is;
//   - stores the .wasm gzip-compressed only (pflow_native_wasm_bg.wasm.gz):
//     the webserver serves it with Content-Encoding: gzip, and nginx on
//     pflow.dev does not compress application/wasm;
//   - snapshots the specs of the commands pflow.xyz exposes (EXPOSED below)
//     into commands.js, so the registry can list them without loading wasm;
//   - writes pflow-native-wasm.lock with the version, commit and sha256s,
//     which public/petri-wasm_test.ts checks.
//
// The lists and checkExposure() below are imported by public/petri-wasm_test.ts
// too, so the node: modules are loaded in main() only (Deno would otherwise
// want @types/node to type-check the test).

// The native commands the editor's registry exposes: the browser-safe subset
// of pflow-native's registry (177 commands at 0.8.0, commit 44db841). A
// command is exposed when it runs from inline arguments (each call reloads the
// editor's document into the engine), needs no OS access, and its result is
// something the page can show: a JSON result or an artifact in the Results
// dialog. The rest is listed under "Not exposed", with the reason.
//
// The page keeps ONE engine, and what outlives a document in it (the model
// library, systems, macros, notes and the store) is saved in browser storage
// after every call that changes it and restored when the engine loads
// (petri-wasm.js), so the session commands below survive a reload.
export const EXPOSED = [
  // phase 2: structural analysis
  'analysis.validate', 'analysis.incidence', 'analysis.invariants', 'analysis.siphons',
  'analysis.verify', 'analysis.reach', 'analysis.reachability', 'analysis.canonical', 'analysis.classify',
  // phase 3: the simulation workbench (sim.ssa and sim.sde stay the JS engines')
  'sim.equilibrium', 'sim.scenario', 'sim.compare', 'sim.crosscheck', 'analysis.diagnose', 'opt.heatmap', 'opt.optimize',
  // phase 6: sim's component library (calibration discipline as templates)
  'compose.components', 'compose.fuse', 'compose.extend',
  // the rest of the browser-safe registry
  'sim.run', 'sim.evaluate', 'opt.fit', 'opt.distill',
  'export.svg', 'file.examples', 'file.open_example', 'file.seal',
  'net.layout', 'net.set_colors',
  'provenance.verify_receipt', 'provenance.check_witness',
  'data.load_log', 'data.log_info', 'data.calibrate', 'data.conformance', 'data.replay', 'data.generate', 'data.discover',
  // session state, kept in browser storage: the model library, systems of
  // bound models, notes, macros and the content-addressed store
  'model.save', 'model.list', 'model.get', 'model.open', 'model.import', 'model.delete', 'compose.diff',
  'system.set_port', 'system.ports', 'system.bind', 'system.binding', 'system.bindings', 'system.unbind',
  'system.create', 'system.show', 'system.list', 'system.delete', 'system.run',
  'note.add', 'note.list', 'note.delete', 'note.clear',
  'macro.define', 'macro.list', 'macro.get', 'macro.delete', 'macro.play',
  'store.put', 'store.get', 'store.open', 'store.list', 'store.delete', 'store.link', 'store.edges', 'store.neighbors',
  'store.query', 'store.collection_create', 'store.collection_add', 'store.collection_list', 'store.license',
  'store.supersede', 'store.migration_offers', 'store.accept_migration', 'store.map_put', 'store.map_get',
  'store.map_list', 'store.graph', 'store.info',
];

// Exposed commands that edit the net: the bridge commits the engine's
// exported document after them (petri-commands.js nativeCommands).
export const EDITS = [
  'compose.fuse', 'compose.extend', 'file.open_example', 'file.seal', 'net.layout', 'net.set_colors', 'data.discover',
  'model.open', 'store.open', 'macro.play',
];

// Edits that REPLACE the document (the engine's export is the new net, with
// nothing carried over from the old one); the others keep the editor's name,
// description, parents and goals, which the engine does not carry.
export const REPLACES = ['file.open_example', 'data.discover', 'model.open', 'store.open'];

// Commands that edit the open net only when their `model` argument names it
// (absent or "current"); naming a library model edits the library instead.
// system.set_port declares the port in the document's "ports" field.
export const EDITS_ON_CURRENT = ['system.set_port'];

// Commands that change the state the page saves in browser storage (the
// library, systems, notes, macros, the store). The bridge does not need the
// list to save (it compares the engine's state after every call); the chat
// does: these are the person's own saved data, written at once and not
// previewable in its sandbox, so they are not among its tools
// (petri-tools.js).
export const WRITES_STATE = [
  'model.save', 'model.import', 'model.delete',
  'system.set_port', 'system.bind', 'system.unbind', 'system.create', 'system.delete',
  'note.add', 'note.delete', 'note.clear',
  'macro.define', 'macro.delete',
  'store.put', 'store.delete', 'store.link', 'store.collection_create', 'store.collection_add', 'store.license',
  'store.supersede', 'store.accept_migration', 'store.map_put',
];

// Commands that edit the net only when called with apply: true (they set the
// fitted or learned rates on the document); the bridge then commits the
// engine's document like an EDITS command, rates included.
export const EDITS_ON_APPLY = ['opt.fit', 'opt.distill', 'data.calibrate'];

// Arguments that name an artifact. The engine is loaded per call, so its own
// artifact store is empty: the bridge files the registry's artifact of that id
// into the engine first (artifact.put) and passes the engine's id. This is
// what lets data.generate -> data.conformance, sim.ode -> opt.fit and
// analysis.reach -> provenance.check_witness chain across calls.
export const ARTIFACT_ARGS = {
  'opt.fit': ['data'], 'provenance.check_witness': ['artifact'],
  'data.log_info': ['log'], 'data.calibrate': ['log'], 'data.conformance': ['log'], 'data.replay': ['log'], 'data.discover': ['log'],
};

// Arguments dropped from the spec (so the registry rejects them by name):
// `path` reads or writes the host's file system; note.add's `artifact` pins a
// note to one of the engine's results, which the bridge clears after every
// call (results live in the JS registry), so the note would be orphaned at
// once.
export const STRIP_ARGS = { 'export.svg': ['path'], 'data.load_log': ['path'], 'model.import': ['path'], 'note.add': ['artifact'] };

// Commands whose result carries the marking the run ended on: the bridge
// loads it into the editor, as sim.fire does.
export const SETS_MARKING = ['sim.run'];

// Commands whose result is a bare JSON string: the bridge returns it as
// {svg} so a result is always an object.
export const TEXT_RESULT = { 'export.svg': 'svg' };

// Not exposed, and why. Every command of the engine is exactly one of:
// exposed, a JS command's id, or listed here; the sync fails on one that is
// none of them, so a command pflow-native adds later needs a decision.
// Keep the PR body in step with this block.
//
//   Same id as a JS command (the JS implementation stays the page's, and
//   parity/native/ compares it with the wasm one): found by comparing with
//   COMMANDS (37 ids at 0.8.0). A native id registered under a JS id would
//   silently replace it, so exposure is checked against COMMANDS below and
//   Registry's constructor refuses a duplicate id too.
export const NOT_EXPOSED = [
  { why: 'reads or writes the host (file system, network, GPU, proof system): not available in a browser',
    ids: ['file.open', 'file.save', 'file.open_url', 'export.png', 'view.screenshot'], prefixes: ['zk.'] },
  { why: 'UI-only: the page has its own view, tool and panels',
    ids: ['tool.set', 'view.string_diagram'], prefixes: ['view.'] },
  { why: 'needs the editor\'s selection or clipboard, which a per-call engine cannot see',
    ids: ['edit.select', 'edit.select_all', 'edit.select_none', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.duplicate', 'net.move_by'] },
  { why: 'the engine\'s state API: the bridge saves and restores the session itself, through Engine.dumpState/restoreState (session.*); system.dump_state/restore_state are the native app\'s autosave of the systems part of the same state',
    ids: ['system.dump_state', 'system.restore_state'], prefixes: ['session.'] },
  { why: 'the engine\'s result list: the page\'s results live in the JS registry (artifact.list, artifact.get, artifact.show_set are JS commands) and the bridge clears the engine\'s after every call, so these would act on nothing',
    ids: ['artifact.put', 'artifact.delete', 'artifact.clear'] },
  { why: 'records the engine\'s journal, but the page\'s own edits are JS commands that never reach the engine, so a recording would silently miss them; macro.define and macro.play are exposed',
    ids: ['macro.record', 'macro.stop'] },
  { why: 'background jobs: the wasm build has no threads, so job.start runs the command at once, which is the command itself plus bookkeeping the page has no use for (its commands are already asynchronous); job records are not part of the saved state',
    prefixes: ['job.'] },
  { why: 'the engine\'s own registry, journal and batch, not the page\'s: command.list would list commands the page does not expose, command.journal misses the page\'s JS commands, and command.batch would run native ids the page routes to its JS engines (Registry.list, .journal and .batch are the page\'s)',
    prefixes: ['command.'] },
  { why: 'the browser has no data directory, so the receipt key is ephemeral and receipts would not verify later (provenance.verify_receipt is exposed, for receipts made elsewhere)',
    ids: ['sim.receipt', 'provenance.key'] },
];

// The guard, as a function the sync below and public/petri-wasm_test.ts both
// run: every engine command must be exactly one of exposed, a JS command's
// id, or listed in NOT_EXPOSED. Returns the ids that break that.
export function checkExposure(engineIds, jsIds) {
  const js = new Set(jsIds);
  const notExposed = (id) => NOT_EXPOSED.some((g) => (g.ids || []).includes(id) || (g.prefixes || []).some((p) => id.startsWith(p)));
  return {
    // an exposed native id equal to a JS command's id would replace it silently
    clashes: EXPOSED.filter((id) => js.has(id)),
    // a command added to the engine with no decision yet
    unaccounted: engineIds.filter((id) => !EXPOSED.includes(id) && !js.has(id) && !notExposed(id)),
    // exposed and listed as not exposed at once
    contradictions: EXPOSED.filter(notExposed),
    // exposed but not in the engine
    missing: EXPOSED.filter((id) => !engineIds.includes(id)),
  };
}

// Run as a script (node scripts/sync-native-wasm.mjs ...), not when a test
// imports the lists above.
async function main() {
  // A computed specifier, so Deno leaves these out of the test's module graph.
  const node = (m) => import(`node:${m}`);
  const { createHash } = await node('crypto');
  const { mkdirSync, readFileSync, writeFileSync } = await node('fs');
  const { join, resolve } = await node('path');
  const { gzipSync } = await node('zlib');
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : dflt;
  };
  const from = arg('from');
  const commit = arg('commit', 'unknown');
  const to = arg('to', 'public/vendor/pflow-native-wasm');
  if (!from) {
    console.error('usage: node scripts/sync-native-wasm.mjs --from <wasm-shim dir> --commit <sha> [--to dir]');
    process.exit(2);
  }

  // The collision guard: a native id equal to a JS command's id would replace
  // it silently (the registry is a Map keyed by id). Checked against the JS
  // registry's own ids before anything is written; Registry's constructor
  // repeats the check at run time.
  const { COMMANDS } = await import(new URL('../public/petri-commands.js', import.meta.url).href);
  const jsIds = new Set(COMMANDS.map((c) => c.id));
  const clashes = checkExposure([], jsIds).clashes;
  if (clashes.length) {
    console.error(`refusing to vendor: exposed native ids collide with JS commands: ${clashes.join(', ')}`);
    process.exit(1);
  }
  for (const list of [EDITS, REPLACES, SETS_MARKING, Object.keys(ARTIFACT_ARGS), EDITS_ON_APPLY, EDITS_ON_CURRENT, WRITES_STATE, Object.keys(STRIP_ARGS), Object.keys(TEXT_RESULT)]) {
    const stray = list.filter((id) => !EXPOSED.includes(id));
    if (stray.length) { console.error(`configured but not exposed: ${stray.join(', ')}`); process.exit(1); }
  }

  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const glue = readFileSync(join(from, 'pflow_native_wasm.js'));
  const wasm = readFileSync(join(from, 'pflow_native_wasm_bg.wasm'));
  const { Engine, initSync } = await import(new URL(`file://${resolve(from, 'pflow_native_wasm.js')}`).href);
  initSync({ module: wasm });
  const all = JSON.parse(new Engine().listCommands(''));
  const { unaccounted, contradictions } = checkExposure(all.map((c) => c.id), jsIds);
  if (unaccounted.length) {
    console.error(`the engine has commands that are neither exposed, a JS id, nor in NOT_EXPOSED: ${unaccounted.join(', ')}`);
    process.exit(1);
  }
  if (contradictions.length) {
    console.error(`exposed and in NOT_EXPOSED at once: ${contradictions.join(', ')}`);
    process.exit(1);
  }

  const gz = gzipSync(wasm, { level: 9 });
  mkdirSync(to, { recursive: true });
  writeFileSync(join(to, 'pflow_native_wasm.js'), glue);
  writeFileSync(join(to, 'pflow_native_wasm_bg.wasm.gz'), gz);

  const specs = EXPOSED.map((id) => {
    const c = all.find((x) => x.id === id);
    if (!c) throw new Error(`the engine has no ${id}`);
    let args = c.args;
    const strip = STRIP_ARGS[id] || [];
    if (strip.length) {
      const properties = Object.fromEntries(Object.entries(args.properties || {}).filter(([k]) => !strip.includes(k)));
      args = { ...args, properties, required: (args.required || []).filter((k) => !strip.includes(k)) };
    }
    return {
      id: c.id, label: c.label, help: c.help, args, journal: !!c.journal,
      ...(EDITS.includes(id) ? { edits: REPLACES.includes(id) ? 'replace' : true } : {}),
      ...(EDITS_ON_APPLY.includes(id) ? { editsOnApply: true } : {}),
      ...(EDITS_ON_CURRENT.includes(id) ? { editsOnCurrent: 'model' } : {}),
      ...(WRITES_STATE.includes(id) ? { writesState: true } : {}),
      ...(ARTIFACT_ARGS[id] ? { artifactArgs: ARTIFACT_ARGS[id] } : {}),
      ...(SETS_MARKING.includes(id) ? { setsMarking: true } : {}),
      ...(TEXT_RESULT[id] ? { textResult: TEXT_RESULT[id] } : {}),
    };
  });
  writeFileSync(join(to, 'commands.js'),
    `// Generated by scripts/sync-native-wasm.mjs from pflow-native ${commit} (pflow-native-wasm ${Engine.version()}).\n` +
    `// The specs of the native commands the editor exposes; do not edit by hand.\n` +
    `export const NATIVE_VERSION = ${JSON.stringify(Engine.version())};\n` +
    `export const NATIVE_COMMANDS = ${JSON.stringify(specs, null, 2)};\n`);

  const lock = {
    _comment: 'pflow-native wasm shim vendored by scripts/sync-native-wasm.mjs; checked by public/petri-wasm_test.ts',
    version: Engine.version(),
    commit,
    commands: all.length,
    exposed: EXPOSED,
    files: {
      'pflow_native_wasm.js': sha(glue),
      'pflow_native_wasm_bg.wasm': sha(wasm),
      'pflow_native_wasm_bg.wasm.gz': sha(gz),
    },
    bytes: { wasm: wasm.length, gzip: gz.length },
  };
  writeFileSync(join(to, '..', '..', '..', 'pflow-native-wasm.lock'), JSON.stringify(lock, null, 2) + '\n');
  console.log(`vendored pflow-native-wasm ${Engine.version()} (${commit}): ${all.length} commands, ${EXPOSED.length} exposed; wasm ${wasm.length} B, gzip ${gz.length} B`);
}

// node sets argv[1] to the script's absolute path.
if (typeof process !== 'undefined' && process.argv[1] === decodeURIComponent(new URL(import.meta.url).pathname)) await main();
