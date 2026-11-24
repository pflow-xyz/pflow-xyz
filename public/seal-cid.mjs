// seal-cid.js — single source of truth for JS-side CID computation.
//
// Produces a CIDv1 (dag-json codec, sha2-256, base58btc) that is byte-for-byte
// identical to the Go server's internal/seal.SealJSONLD. Parity is enforced by
// parity/parity_check.mjs against parity/golden.json (see `make test-parity`).
//
// Canonical contract (must match internal/seal/seal.go exactly):
//   1. Remove the top-level "@id" (self-referential — a net's @id equals its own
//      CID, so it cannot appear in its own preimage; this makes the CID idempotent).
//   2. JSON-LD -> RDF via URDNA2015 N-Quads, using the preloaded pflow.xyz context
//      and an empty base IRI, with safe-mode off (tolerates relative @ids like Go).
//   3. SHA-256 the N-Quads bytes.
//   4. Wrap as CIDv1: 0x01 | varint(0x0129 dag-json) | 0x12 (sha2-256) | 0x20 | hash.
//   5. base58btc encode, prefixed with 'z'.
//
// Sealing contract version 2 (SEAL_VERSION, 2026-11-24) adds one step before
// 2: in a document whose @context is the pflow schema, a null that comes
// before a value in a list term (arcs, token, weight, capacity, initial,
// parents) is sealed as the IRI NULL_IRI. JSON-LD drops every null in a
// @list, so under version 1 capacity [null,3] and [3] had one CID. Trailing
// nulls are still dropped ([3,null] and [3] read the same, and [null] is how
// the editor writes an unbounded place), so only a document with a null
// before a value gets a new CID; none was stored when the change was made
// (docs/model-identity.md, "Sealing contract versions").
import jsonld from './vendor/jsonld.bundle.mjs';

// EXACT context preloaded by internal/seal/seal.go's caching document loader.
// Keep in lockstep with seal.go — any drift breaks JS/Go CID parity.
export const PFLOW_CONTEXT = {
  '@context': {
    '@vocab': 'https://pflow.xyz/schema#',
    arcs: { '@id': 'https://pflow.xyz/schema#arcs', '@container': '@list' },
    places: 'https://pflow.xyz/schema#places',
    transitions: 'https://pflow.xyz/schema#transitions',
    token: { '@id': 'https://pflow.xyz/schema#token', '@container': '@list' },
    source: 'https://pflow.xyz/schema#source',
    target: 'https://pflow.xyz/schema#target',
    weight: { '@id': 'https://pflow.xyz/schema#weight', '@container': '@list' },
    inhibitTransition: 'https://pflow.xyz/schema#inhibitTransition',
    capacity: { '@id': 'https://pflow.xyz/schema#capacity', '@container': '@list' },
    initial: { '@id': 'https://pflow.xyz/schema#initial', '@container': '@list' },
    // parents: ordered (newest-first) provenance chain of parent CIDs. @list so
    // lineage order is part of the content identity — mirrors beats-bitwrap-io.
    parents: { '@id': 'https://pflow.xyz/schema#parents', '@container': '@list' },
    offset: 'https://pflow.xyz/schema#offset',
    x: 'https://pflow.xyz/schema#x',
    y: 'https://pflow.xyz/schema#y',
  },
};

// Offline, deterministic loader — serves the pflow context, refuses the network.
const documentLoader = async (url) => {
  if (url === 'https://pflow.xyz/schema' || url === 'https://pflow.xyz/schema#') {
    return { document: PFLOW_CONTEXT, documentUrl: url, contextUrl: null };
  }
  throw new Error('seal-cid: refusing remote context fetch: ' + url);
};

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let enc = '';
  while (num > 0n) { enc = B58[Number(num % 58n)] + enc; num /= 58n; }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) enc = '1' + enc;
  return enc;
}

// Unsigned LEB128 varint. 0x0129 (dag-json) -> [0xA9, 0x02].
function varint(n) {
  const out = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return out;
}

async function sha256(str) {
  const bytes = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

export const SEAL_VERSION = 2;

// NULL_IRI stands for a null that a list term keeps (version 2).
export const NULL_IRI = 'https://pflow.xyz/schema#null';

const LIST_TERMS = new Set(['arcs', 'token', 'weight', 'capacity', 'initial', 'parents']);

const isPflowDoc = (doc) => doc !== null && typeof doc === 'object' && !Array.isArray(doc)
  && (doc['@context'] === 'https://pflow.xyz/schema' || doc['@context'] === 'https://pflow.xyz/schema#');

// Copy v with version 2's list rule applied; changed.v is set when it did anything.
function keepListNulls(v, changed) {
  if (Array.isArray(v)) return v.map((e) => keepListNulls(e, changed));
  if (v === null || typeof v !== 'object') return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    let x = val;
    if (LIST_TERMS.has(k) && Array.isArray(val)) {
      let last = -1;
      val.forEach((e, i) => { if (e !== null) last = i; });
      x = val.map((e, i) => {
        if (e === null && i < last) { changed.v = true; return { '@id': NULL_IRI }; }
        return e;
      });
    }
    out[k] = keepListNulls(x, changed);
  }
  return out;
}

// changedByV2 says whether doc's CID differs between versions 1 and 2: a pflow
// document with a null before a value in a list term.
export function changedByV2(doc) {
  if (!isPflowDoc(doc)) return false;
  const changed = { v: false };
  keepListNulls(doc, changed);
  return changed.v;
}

// computeCid returns the canonical CIDv1 string for a JSON-LD Petri net document.
// The top-level @id is removed before hashing (see contract above).
// opts.version 1 seals under the old contract, to check a CID minted before
// version 2; the default is SEAL_VERSION.
export async function computeCid(doc, opts = {}) {
  const { '@id': _ignored, ...stripped } = doc;
  const version = opts.version ?? SEAL_VERSION;
  const docForCid = version >= 2 && isPflowDoc(stripped) ? keepListNulls(stripped, { v: false }) : stripped;

  const nquads = await jsonld.canonize(docForCid, {
    algorithm: 'URDNA2015',
    format: 'application/n-quads',
    documentLoader,
    base: '',
    safe: false,
  });

  const hash = await sha256(nquads);
  const bytes = Uint8Array.from([0x01, ...varint(0x0129), 0x12, hash.length, ...hash]);
  return 'z' + encodeBase58(bytes);
}
