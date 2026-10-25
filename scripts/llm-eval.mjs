// llm-eval.mjs — run captured Gemini drafts (testdata/llm/*.json, written by
// `make llm-eval`) through the browser's load gate (public/petri-draft.js) and
// report how many pass first time, the median net size and the warnings.
//
//   node scripts/llm-eval.mjs testdata/llm/*.json
//
// Record the pass rate in the prompt file's header when draft-net-v*.md changes.
import { readFileSync } from 'node:fs';
import { gateDraft } from '../public/petri-draft.js';
import { formatIssue } from '../public/petri-validate.js';

const files = process.argv.slice(2);
let pass = 0;
const sizes = [];
const warnings = new Map();
for (const f of files) {
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  if (rec.error) {
    console.log(`FAIL ${f}: upstream ${rec.error}`);
    continue;
  }
  let draft;
  try {
    draft = JSON.parse(rec.raw);
  } catch {
    console.log(`FAIL ${f}: reply is not JSON`);
    continue;
  }
  const r = await gateDraft(draft);
  if (r.ok) {
    pass++;
    sizes.push((draft.places?.length || 0) + (draft.transitions?.length || 0));
    for (const w of r.warnings) warnings.set(w.message, (warnings.get(w.message) || 0) + 1);
    console.log(`ok   ${f}: ${draft.places.length} places, ${draft.transitions.length} transitions`);
  } else {
    console.log(`FAIL ${f} (${r.stage}): ${r.errors.slice(0, 3).map(formatIssue).join('; ')}`);
  }
}
sizes.sort((a, b) => a - b);
const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
console.log(`\n${pass}/${files.length} pass the gate first time; median net size ${median} nodes`);
for (const [w, n] of [...warnings].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  warning x${n}: ${w}`);
