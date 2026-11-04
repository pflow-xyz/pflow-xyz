// sync-chyp-wasm.mjs — vendor chyp-rs's wasm bundle into public/vendor/chyp-rs-wasm/.
//
//   node scripts/sync-chyp-wasm.mjs --from ../chyp-rs/pkg --commit <chyp-rs sha> [--to public/vendor/chyp-rs-wasm]
//
// Build the bundle first in chyp-rs: `make wasm` (cargo's wasm profile: opt-level "z", lto, panic=abort;
// then wasm-bindgen --target web). This is what the Laws view runs (public/compose/laws-live.js). This script:
//
//   - copies the wasm-bindgen glue (chyp_rs.js and the chyp_rs.d.ts it names) as is, and chyp-rs's LICENSE, NOTICE and THIRD-PARTY-NOTICES as .txt
//     (Apache-2.0 §4: they carry Chyp's attribution, and Chyp's licence is the port's);
//   - stores the .wasm compressed only, as pflow-native's is: chyp_rs_bg.wasm.gz (gzip -9) and chyp_rs_bg.wasm.br
//     (brotli, quality 11). cmd/webserver/wasm.go answers a request for the .wasm from them, by Accept-Encoding;
//   - writes chyp-rs-wasm.lock with the commit, the sizes and the sha256s, which public/compose/chyp/files_test.ts
//     checks (it also checks that the .gz and the .br both decompress to the wasm the lock names).
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const from = arg('--from'), commit = arg('--commit'), to = arg('--to', 'public/vendor/chyp-rs-wasm');
if (!from || !commit) {
  console.error('usage: node scripts/sync-chyp-wasm.mjs --from <chyp-rs pkg dir> --commit <chyp-rs sha> [--to dir]');
  process.exit(2);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
mkdirSync(to, { recursive: true });
const wasm = readFileSync(join(from, 'chyp_rs_bg.wasm'));
const gz = gzipSync(wasm, { level: 9 });
const br = brotliCompressSync(wasm, { params: {
  [constants.BROTLI_PARAM_QUALITY]: 11,
  [constants.BROTLI_PARAM_LGWIN]: 24,
  [constants.BROTLI_PARAM_SIZE_HINT]: wasm.length,
} });
writeFileSync(join(to, 'chyp_rs_bg.wasm.gz'), gz);
writeFileSync(join(to, 'chyp_rs_bg.wasm.br'), br);
const files = { 'chyp_rs_bg.wasm': sha(wasm), 'chyp_rs_bg.wasm.gz': sha(gz), 'chyp_rs_bg.wasm.br': sha(br) };
for (const f of ['chyp_rs.js', 'chyp_rs.d.ts']) {
  copyFileSync(join(from, f), join(to, f));
  files[f] = sha(readFileSync(join(to, f)));
}
// .txt: production's nginx serves a static file only for the extensions VIEWS.md lists.
for (const f of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES']) {
  copyFileSync(join(from, f), join(to, `${f}.txt`));
  files[`${f}.txt`] = sha(readFileSync(join(to, `${f}.txt`)));
}
const lock = {
  _comment: 'chyp-rs wasm bundle vendored by scripts/sync-chyp-wasm.mjs; checked by public/compose/chyp/files_test.ts',
  repo: 'https://github.com/stackdump/chyp-rs',
  commit,
  upstream: { repo: 'https://github.com/akissinger/chyp', commit: '3d2848361e261b07a86daaacf70b2b4b018affcf', license: 'Apache-2.0' },
  bytes: { wasm: wasm.length, gzip: gz.length, brotli: br.length },
  files,
};
writeFileSync('chyp-rs-wasm.lock', `${JSON.stringify(lock, null, 2)}\n`);
console.log(`vendored chyp-rs ${commit.slice(0, 7)}: wasm ${wasm.length} B, gzip ${gz.length} B, brotli ${br.length} B`);
