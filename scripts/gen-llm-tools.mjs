// gen-llm-tools.mjs — write public/llm-tools.json, the chat's tool manifest,
// from the command registry (public/petri-commands.js + the vendored native
// specs). The webserver reads it from its embedded public/ for
// /api/llm/turn; public/petri-tools_test.ts fails when it drifts.
//
//   node scripts/gen-llm-tools.mjs
import { writeFileSync } from 'node:fs';
import { Registry, createHeadlessHost } from '../public/petri-commands.js';
import { buildManifest } from '../public/petri-tools.js';

// A host with a view, so commands that need one are listed as available.
const host = createHeadlessHost();
host.capabilities = new Set(['view']);
const manifest = buildManifest(new Registry(host).list());
writeFileSync(new URL('../public/llm-tools.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(`public/llm-tools.json: ${manifest.tools.length} tools (${manifest.version})`);
