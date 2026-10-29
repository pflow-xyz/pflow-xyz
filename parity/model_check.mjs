// model_check.mjs — JS side of the model-identity contract.
//
// Asserts that public/model-cid.mjs applies the rule exactly as internal/model
// (Go) does, on the shared vectors in parity/model/golden.json: for every
// fixture the kind, the sealed CID (the unchanged sealing contract), the model
// CID and whether a bare wrapper reduced to its part; for every refusal the
// same error code; for every canonical-JSON vector the same text. It also
// proves the backport: every net in parity/fixtures and examples keeps the CID
// computeCid gives it. Green here and in `go test ./internal/model/` (and in
// pflow-native's crates/core/tests/model.rs) is the cross-language contract.
//
// Runs under node (`node parity/model_check.mjs`) and deno. Exits non-zero on mismatch.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeCid } from '../public/seal-cid.mjs';
import { identify, check, canonicalJson, kindOf, ModelError } from '../public/model-cid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), 'utf8');
const golden = JSON.parse(read('model', 'golden.json'));
const canon = JSON.parse(read('model', 'canonical.json'));

let ok = 0;
let bad = 0;
const fail = (msg) => { console.error('  FAIL ' + msg); bad++; };
const pass = (msg) => { console.log('  ok   ' + msg); ok++; };

for (const v of golden.vectors) {
  const doc = JSON.parse(read('model', v.file));
  const id = await identify(doc);
  const kindOk = id.kind === v.kind || (v.reduced && id.kind === 'net');
  if (kindOk && id.sealed === v.sealed && id.cid === v.model && id.reduced === v.reduced
      && (!v.parts || JSON.stringify(id.parts) === JSON.stringify(v.parts))) {
    pass(`${v.name}  ${id.cid}${id.reduced ? '  (reduced)' : ''}`);
  } else {
    fail(`${v.name}\n    want kind=${v.kind} sealed=${v.sealed} model=${v.model} reduced=${v.reduced}\n    got  kind=${id.kind} sealed=${id.sealed} model=${id.cid} reduced=${id.reduced}`);
  }
}

for (const r of golden.refusals) {
  try {
    check(r.doc);
    fail(`refusal ${r.name}: accepted, want ${r.code}`);
  } catch (e) {
    if (e instanceof ModelError && e.code === r.code) pass(`refusal ${r.name}  ${r.code}`);
    else fail(`refusal ${r.name}: got ${e && e.code ? e.code : e}, want ${r.code}`);
  }
}

for (const v of canon.vectors) {
  const got = canonicalJson(v.in);
  if (got === v.out && canonicalJson(got) === got) pass(`canonical: ${v.name}`);
  else fail(`canonical: ${v.name}\n    want ${v.out}\n    got  ${got}`);
}

// Backport: a net's model CID is the CID computeCid has always given it.
let nets = 0;
for (const dir of ['fixtures', '../examples']) {
  const base = join(here, dir);
  for (const f of readdirSync(base).filter((n) => n.endsWith('.jsonld'))) {
    const doc = JSON.parse(readFileSync(join(base, f), 'utf8'));
    if (kindOf(doc) !== 'net') continue;
    const id = await identify(doc);
    const want = await computeCid(doc);
    if (id.cid === want && id.sealed === want && !id.reduced) { nets++; }
    else fail(`backport ${dir}/${f}: model CID ${id.cid} != ${want}`);
  }
}
pass(`backport: ${nets} nets in parity/fixtures and examples keep their CID`);

if (bad > 0) {
  console.error(`\nmodel_check: ${bad} failure(s) — JS and Go disagree on the model-identity rule`);
  process.exit(1);
}
console.log(`\nmodel_check OK: ${ok} checks`);
