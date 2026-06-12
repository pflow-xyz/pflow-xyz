// parity_check.mjs — JS side of the JS/Go CID parity contract.
//
// Asserts that public/seal-cid.js (the same module the browser editor uses)
// reproduces every CID in parity/golden.json for the matching fixture. The Go
// side checks the identical fixtures/golden in internal/seal/parity_test.go.
// Green on both => the JS and Go CID pipelines agree byte-for-byte.
//
// Runs under both node (`node parity/parity_check.mjs`) and deno
// (`deno run --allow-read parity/parity_check.mjs`). Exits non-zero on mismatch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeCid } from '../public/seal-cid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));

let checked = 0;
let failed = 0;
for (const [name, want] of Object.entries(golden)) {
  if (name === '_comment') continue;
  const doc = JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
  const got = await computeCid(doc);
  if (got === want) {
    console.log(`  ok   ${name}  ${got}`);
    checked++;
  } else {
    console.error(`  FAIL ${name}\n    want ${want}\n    got  ${got}`);
    failed++;
  }
}

if (checked === 0) {
  console.error('parity_check: no fixtures checked');
  process.exit(1);
}
if (failed > 0) {
  console.error(`\nparity_check: ${failed} mismatch(es) — JS and Go CIDs diverge`);
  process.exit(1);
}
console.log(`\nparity_check OK: ${checked} fixtures match golden CIDs`);
