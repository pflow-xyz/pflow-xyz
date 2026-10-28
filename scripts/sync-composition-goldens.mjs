// sync-composition-goldens.mjs — vendor pflow-native's composition-views goldens
// into parity/composition-views/.
//
//   node scripts/sync-composition-goldens.mjs --from ../pflow-native --commit <sha> [--to parity/composition-views] [--allow-mismatch]
//
// (or `make sync-composition-goldens FROM=../pflow-native COMMIT=<sha>`). FROM is a
// pflow-native git checkout, not the wasm-shim directory sync-native-wasm takes;
// it is only read, with `git show`, and its working tree and HEAD do not matter.
// This script:
//
//   - reads parity/composition-views/goldens.json as committed at COMMIT, byte for
//     byte (the scene manifests pflow-native's egui renderers collect, headless:
//     docs/composition-views-scene.md there), and writes it unmodified;
//   - rewrites goldens.lock with the full commit and the file's sha256 (keeping the
//     lock's _comment and source), which parity/composition-views/parity_test.ts
//     checks, along with the rule that the commit is the one the vendored wasm
//     (pflow-native-wasm.lock) was built from.
//
// So COMMIT is the commit passed to `make sync-native-wasm` (the goldens must come
// from the same pflow-native as the wasm that is compared with them); refresh the
// wasm first, then run this. If pflow-native-wasm.lock names another commit the
// script stops before it writes anything and exits 1, since parity_test.ts would
// fail on the pair; --allow-mismatch (make: ALLOW_MISMATCH=1) vendors anyway, with a
// warning, for the case where the wasm is about to be re-vendored. native-goldens (parity/native/) has no bundle.* or
// plan.* cases, so it does not cover these. A failing parity_test.ts after a sync is
// a finding about one renderer, never a reason to edit goldens.json by hand.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GOLDENS = 'parity/composition-views/goldens.json'; // the path in pflow-native, and here

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function main() {
  const from = arg('from');
  const commit = arg('commit');
  const dir = arg('to', fileURLToPath(new URL('../parity/composition-views', import.meta.url)));
  const allowMismatch = process.argv.includes('--allow-mismatch');
  if (!from || !commit) {
    console.error('usage: node scripts/sync-composition-goldens.mjs --from <pflow-native checkout> --commit <sha> [--to <dir>] [--allow-mismatch]');
    process.exit(2);
  }
  // git would take a leading dash for an option; a commit is a hash or a ref name, which cannot start with one.
  if (commit.startsWith('-') || from.startsWith('-')) {
    console.error('--from and --commit must not start with "-"');
    process.exit(2);
  }
  const git = (...args) => execFileSync('git', ['-C', from, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  // Everything is read before anything is written: a commit without the file leaves the vendored copy alone.
  let full, bytes;
  try {
    full = git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim();
  } catch (e) {
    console.error(`${from}: no commit ${commit} (${String(e.stderr || e.message).trim()})`);
    process.exit(1);
  }
  try {
    bytes = git('show', `${full}:${GOLDENS}`);
  } catch (e) {
    console.error(`${from} at ${full}: no ${GOLDENS} (${String(e.stderr || e.message).trim()}). The goldens come from the pflow-native commit the vendored wasm was built from; pick one that has them.`);
    process.exit(1);
  }
  const doc = JSON.parse(bytes.toString('utf8'));
  const manifests = Array.isArray(doc) ? doc : doc.manifests || doc.cases || doc.goldens || [];
  if (!manifests.length) {
    console.error(`${from} at ${full}: ${GOLDENS} holds no manifests`);
    process.exit(1);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // The wasm these goldens are compared with must come from the same commit (parity_test.ts checks it).
  // Stop before writing anything unless told the mismatch is intended.
  let wasm = null;
  try { wasm = JSON.parse(readFileSync(fileURLToPath(new URL('../pflow-native-wasm.lock', import.meta.url)), 'utf8')); } catch { /* no wasm lock to compare with */ }
  if (wasm && wasm.commit !== full) {
    const what = `pflow-native-wasm.lock is at ${String(wasm.commit).slice(0, 7)}, not ${full.slice(0, 7)}; parity_test.ts needs the goldens and the wasm from one commit`;
    if (!allowMismatch) {
      console.error(`error: ${what}. Re-vendor the wasm first (make sync-native-wasm COMMIT=${full}), or pass --allow-mismatch (make: ALLOW_MISMATCH=1) to vendor these goldens anyway. Nothing was written.`);
      process.exit(1);
    }
    console.warn(`warning: ${what} (--allow-mismatch given; parity_test.ts will fail until the wasm is re-vendored at ${full.slice(0, 7)})`);
  }

  const lockPath = `${dir}/goldens.lock`;
  let old = {};
  try { old = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* first sync: the defaults below */ }
  const lock = {
    _comment: old._comment || `${GOLDENS}, copied unmodified from pflow-native at this commit (git show <commit>:${GOLDENS}); checked by parity_test.ts. The vendored wasm (pflow-native-wasm.lock) must come from the same commit.`,
    source: old.source || `github.com/pflow-xyz/pflow-native ${GOLDENS}`,
    commit: full,
    sha256,
  };
  writeFileSync(`${dir}/goldens.json`, bytes);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  console.log(`vendored ${GOLDENS} @ ${full.slice(0, 7)} into ${dir}: ${manifests.length} manifests, ${bytes.length} bytes, sha256 ${sha256.slice(0, 12)}...`);
  console.log('run `make test-js` to verify');
}

main();
