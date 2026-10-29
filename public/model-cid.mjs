// model-cid.mjs — the model-identity rule, JS side. Mirrors internal/model
// (Go) and pflow-native's crates/core/src/cid.rs `model_cid` (Rust); parity is
// enforced by parity/model_check.mjs against parity/model/golden.json
// (`make test-parity`).
//
// The sealing contract is untouched and lives in seal-cid.mjs (this module
// only imports it, so the vendored copies of seal-cid.mjs stay byte-identical).
// This module decides WHAT is sealed:
//
//   net          Shape A editor JSON-LD. Its model CID is the CID it has always
//                had: computeCid(doc). Nothing is re-minted.
//   composition  @type "PetriNetBundle" (go-pflow metamodel.Bundle shape). Each
//                subnet is inline (`model`, for parts with no net CID) or a
//                stored net by CID (`cid`). Sealed as written. Changing a link
//                changes only the composition's CID; each part keeps its own.
//   bare wrapper a composition that is nothing but one net by reference IS
//                that net: its model CID is the part's CID.
//   plan         @type "SearchPlan": {model_cid, plan}. `plan` is canonical
//                JSON text, because a sealed array outside the @list terms
//                hashes as an unordered set.
//
// docs/model-identity.md has the rule and the backport proof.
import { computeCid } from './seal-cid.mjs';

export const CONTEXT = 'https://pflow.xyz/schema';
export const TYPE_COMPOSITION = 'PetriNetBundle';
export const TYPE_PLAN = 'SearchPlan';
export const KIND_NET = 'net';
export const KIND_COMPOSITION = 'composition';
export const KIND_PLAN = 'plan';

const CID_RE = /^z[1-9A-HJ-NP-Za-km-z]{20,80}$/;
export const isCid = (s) => typeof s === 'string' && CID_RE.test(s);

/** A refusal with a stable code, rendered "[CODE] message". */
export class ModelError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'ModelError';
    this.code = code;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Everything that is neither a composition nor a plan is a net, so unknown documents keep their CID. */
export function kindOf(doc) {
  if (isObj(doc)) {
    if (doc['@type'] === TYPE_COMPOSITION) return KIND_COMPOSITION;
    if (doc['@type'] === TYPE_PLAN) return KIND_PLAN;
  }
  return KIND_NET;
}

/** The structural check of a composition or plan; a net passes unexamined. Throws ModelError. */
export function check(doc) {
  const kind = kindOf(doc);
  if (kind === KIND_COMPOSITION) return checkComposition(doc);
  if (kind === KIND_PLAN) return checkPlan(doc);
}

function checkComposition(doc) {
  const subs = Array.isArray(doc.subnets) ? doc.subnets : [];
  if (subs.length === 0) throw new ModelError('E_NO_SUBNETS', 'a composition needs at least one subnet');
  const ids = new Set();
  subs.forEach((m, i) => {
    if (!isObj(m)) throw new ModelError('E_SUBNET', `subnets[${i}] is not an object`);
    const id = typeof m.id === 'string' ? m.id : '';
    if (!id) throw new ModelError('E_SUBNET', `subnets[${i}] has no id`);
    if (ids.has(id)) throw new ModelError('E_SUBNET', `subnet id "${id}" appears twice`);
    ids.add(id);
    const hasCid = has(m, 'cid');
    const hasModel = has(m, 'model');
    if (hasCid && hasModel) throw new ModelError('E_PART', `subnet "${id}" has both cid and model: a part is referenced or inline, not both`);
    if (!hasCid && !hasModel) throw new ModelError('E_PART', `subnet "${id}" has neither cid nor model: a pattern recipe alone does not pin a net`);
    if (hasCid && !isCid(m.cid)) throw new ModelError('E_PART', `subnet "${id}": cid ${JSON.stringify(m.cid)} is not a CID`);
    if (hasModel && !isObj(m.model)) throw new ModelError('E_PART', `subnet "${id}": model is not an object`);
    if (has(m, 'pattern') && !(typeof m.pattern === 'string' && m.pattern)) {
      throw new ModelError('E_PATTERN', `subnet "${id}": pattern must be a non-empty string`);
    }
    if (has(m, 'params')) {
      if (typeof m.params !== 'string') {
        throw new ModelError('E_PATTERN', `subnet "${id}": params must be a canonical-JSON string (arrays inside a sealed document hash as sets, so ordered parameters are embedded as text)`);
      }
      let v;
      try { v = JSON.parse(m.params); } catch { v = null; }
      if (!isObj(v)) throw new ModelError('E_PATTERN', `subnet "${id}": params is not a JSON object`);
    }
  });
  if (Array.isArray(doc.links)) {
    doc.links.forEach((l, i) => {
      if (!isObj(l)) throw new ModelError('E_LINK', `links[${i}] is not an object`);
      for (const k of ['from_subnet', 'from_port', 'to_subnet', 'to_port']) {
        if (has(l, k)) {
          throw new ModelError('E_BUNDLE_SHAPE', `links[${i}] uses "${k}": that is go-pflow's tokenmodel/subnet bundle, not metamodel.Bundle (links are {kind, from:{subnet,…}, to:{subnet,…}})`);
        }
      }
      if (!(typeof l.kind === 'string' && l.kind)) throw new ModelError('E_LINK', `links[${i}] has no kind`);
      for (const side of ['from', 'to']) {
        if (!isObj(l[side])) throw new ModelError('E_LINK', `links[${i}].${side} is not an endpoint object`);
        if (!ids.has(l[side].subnet)) throw new ModelError('E_LINK', `links[${i}].${side} names subnet ${JSON.stringify(l[side].subnet ?? '')}, which is not a part`);
      }
    });
  }
}

function checkPlan(doc) {
  if (!isCid(doc.model_cid)) throw new ModelError('E_PLAN', 'model_cid must be the CID of the model the plan is for');
  if (typeof doc.plan !== 'string') {
    throw new ModelError('E_PLAN', "plan must be the plan's canonical JSON as a string (its lists are ordered; a nested array would hash as a set)");
  }
  let v;
  try { v = JSON.parse(doc.plan); } catch { v = null; }
  if (!isObj(v)) throw new ModelError('E_PLAN', 'plan is not a JSON object');
}

/** The by-reference part CIDs of a composition, in document order. */
export function parts(doc) {
  return (Array.isArray(doc?.subnets) ? doc.subnets : []).filter((m) => isObj(m) && typeof m.cid === 'string').map((m) => m.cid);
}

const BARE_TOP = new Set(['@context', '@id', '@type', 'subnets', 'namespace', 'arc_merge', 'links', 'constraints']);
const BARE_SUBNET = new Set(['@type', 'id', 'net_type', 'cid']);

/**
 * The CID of the net a composition is nothing but, or null. Precisely: one
 * subnet whose only keys are @type, id, net_type and cid; no links and no
 * constraints (absent or empty); no name, version, description, parents or any
 * other key. Flatten returns such a bundle's lone model unchanged, so the
 * wrapper adds nothing to the net's identity. A name, a constraint or a
 * pattern recipe says more, so those stay compositions.
 */
export function bareWrapper(doc) {
  if (kindOf(doc) !== KIND_COMPOSITION) return null;
  for (const [k, v] of Object.entries(doc)) {
    if (!BARE_TOP.has(k)) return null;
    if ((k === 'links' || k === 'constraints') && !(Array.isArray(v) && v.length === 0)) return null;
  }
  const subs = doc.subnets;
  if (!Array.isArray(subs) || subs.length !== 1 || !isObj(subs[0])) return null;
  if (Object.keys(subs[0]).some((k) => !BARE_SUBNET.has(k))) return null;
  return isCid(subs[0].cid) ? subs[0].cid : null;
}

/**
 * Apply the rule to a parsed document: { kind, cid (the model CID), sealed
 * (the CID of the document as written), reduced, parts }. A net is never
 * validated or changed. Throws ModelError for a malformed composition or plan.
 */
export async function identify(doc) {
  const kind = kindOf(doc);
  if (isObj(doc)) check(doc);
  const sealed = await computeCid(doc);
  const id = { kind, cid: sealed, sealed, reduced: false, parts: [] };
  if (kind === KIND_COMPOSITION) {
    id.parts = parts(doc);
    const part = bareWrapper(doc);
    if (part) { id.kind = KIND_NET; id.cid = part; id.reduced = true; }
  }
  return id;
}

/** The model CID alone. */
export async function modelCid(doc) { return (await identify(doc)).cid; }

// ---- canonical JSON text -------------------------------------------------

const cmpCodePoints = (a, b) => {
  // Code-point order (= bytewise UTF-8), not JS's UTF-16 code-unit order.
  const x = Array.from(a); const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};

function esc(s) {
  // Only " \ and controls below 0x20, as serde_json and the Go helper write them.
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 8) out += '\\b';
    else if (c === 12) out += '\\f';
    else if (c === 10) out += '\\n';
    else if (c === 13) out += '\\r';
    else if (c === 9) out += '\\t';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function write(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Object.is(v, -0) ? '0' : String(v);
  if (typeof v === 'string') return esc(v);
  if (Array.isArray(v)) return '[' + v.map(write).join(',') + ']';
  return '{' + Object.keys(v).sort(cmpCodePoints).map((k) => esc(k) + ':' + write(v[k])).join(',') + '}';
}

/**
 * Canonical JSON text for a subnet's `params` or a plan's `plan`: keys sorted
 * by code point, lists in order, no whitespace, numbers as doubles in
 * JSON.stringify's shortest form, strings escaped only for " \ and controls.
 * Takes JSON text or a value. A sealed string is hashed as given and never
 * re-canonicalised.
 */
export function canonicalJson(input) {
  return write(typeof input === 'string' ? JSON.parse(input) : input);
}

/** The sealed document for a search plan on a model (see the header). */
export function newPlan(modelCidStr, plan) {
  if (!isCid(modelCidStr)) throw new ModelError('E_PLAN', `model_cid ${JSON.stringify(modelCidStr)} is not a CID`);
  const doc = { '@context': CONTEXT, '@type': TYPE_PLAN, model_cid: modelCidStr, plan: canonicalJson(plan) };
  checkPlan(doc);
  return doc;
}
