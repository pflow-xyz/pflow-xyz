// gen-llm-tools.mjs — write the chat's tool manifests from the command
// registry (public/petri-commands.js + the vendored native specs):
//
//   public/llm-tools.json       every command (the 'all' toolset)
//   public/llm-goal-tools.json  the goal toolset: run_goal, ask_user,
//                               command_schema, run_command, open_view, the
//                               twelve edit/read tools in GOAL_DIRECT_TOOLS
//                               (public/petri-tools.js, which says why each is
//                               there) and command_index for the long tail
//
// The webserver reads both from its embedded public/ for /api/llm/turn;
// public/petri-tools_test.ts (and petri-chat_test.ts for the first) fail when
// they drift. The goal toolset's run_goal enum is the available goals of
// public/goals.json, so adding a goal means running this again.
//
//   node scripts/gen-llm-tools.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Registry, createHeadlessHost } from '../public/petri-commands.js';
import { buildManifest, buildGoalManifest } from '../public/petri-tools.js';

// A host with a view, so commands that need one are listed as available.
const host = createHeadlessHost();
host.capabilities = new Set(['view']);
const specs = new Registry(host).list();
const goals = JSON.parse(readFileSync(new URL('../public/goals.json', import.meta.url), 'utf8'));

const manifest = buildManifest(specs);
writeFileSync(new URL('../public/llm-tools.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(`public/llm-tools.json: ${manifest.tools.length} tools (${manifest.version})`);

const goalManifest = buildGoalManifest(specs, goals);
writeFileSync(new URL('../public/llm-goal-tools.json', import.meta.url), JSON.stringify(goalManifest, null, 2) + '\n');
console.log(`public/llm-goal-tools.json: ${goalManifest.tools.length} tools, ${goalManifest.command_index.length} indexed commands (${goalManifest.version})`);
