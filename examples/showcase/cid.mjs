// Recompute cafe.jsonld's CID with the browser sealer and compare with @id.
//   node examples/showcase/cid.mjs        (from the pflow-xyz repo root)
import { computeCid } from '../../public/seal-cid.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, 'cafe.jsonld'), 'utf8'));
const cid = await computeCid(doc);
console.log(cid, cid === doc['@id'] ? 'matches @id' : `MISMATCH (expected ${doc['@id']})`);
if (cid !== doc['@id']) process.exit(1);
