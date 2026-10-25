// check-nets.mjs — run the editor's strict check (public/petri-validate.js) over
// net files and print every error and warning.
//
//   node scripts/check-nets.mjs examples/*.jsonld parity/fixtures/*.jsonld
//   node scripts/check-nets.mjs --strict some-net.json
//
// Exits 1 when any file has an error. Handy against a copy of the object store
// (data/o/) before tightening a rule.
import { readFileSync } from 'node:fs';
import { validateNet, formatIssue } from '../public/petri-validate.js';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
let failed = 0;
for (const f of args.filter((a) => a !== '--strict')) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.log(`== ${f}: not JSON (${e.message})`);
    failed++;
    continue;
  }
  const r = validateNet(doc, { strict });
  console.log(`== ${f}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`);
  for (const e of r.errors) console.log(`  error    ${formatIssue(e)}`);
  for (const w of r.warnings) console.log(`  warning  ${formatIssue(w)}`);
  if (!r.ok) failed++;
}
process.exit(failed ? 1 : 0);
