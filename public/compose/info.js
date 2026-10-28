// Inspector info for the things every view draws, built from the model so the
// hover text is the same whichever view shows the piece.

import { PATTERNS, LINK_KINDS, IDIOMS, NS, LINK_STYLE_CITE } from './model.js';
import { cite } from './sources.js';
import { pieceByName, SLOTS, SEARCH_CITES, CONNECT4_EXACT_CITE, PLAN_RS_REV } from './model.js';
import { FLATTEN_CITES } from './model.js';

const ttl = (from, to = from, note = '') => cite('ontology', 'ns/patterns.ttl', from, to, note);

function patternPortDef(subnet, port) {
  const p = PATTERNS[subnet.pattern];
  return [...(p.ports || []), ...(p.portTemplates || [])].find((q) => q.key === port.patternPort);
}

export function subnetInfo(s) {
  const p = PATTERNS[s.pattern];
  return {
    title: `${s.id}: a ${p.prefLabel} instance`,
    concept: { iri: p.iri, types: ['ns:NetPattern'] },
    definition: p.definition,
    facts: [
      ['constructor', p.constructor],
      ['net kind', `${s.netKind} (ns:netKind)`],
      ['places / transitions', `${s.places.length} / ${s.transitions.length}`],
      ['ports', s.ports.map((q) => q.id).join(', ')],
      ['parameters (judgment)', s.why || ''],
      ['labels (judgment)', p.altLabel.join(', ')],
    ],
    caveats: p.caveats,
    cites: [...p.cites, ...(s.cites || [])],
  };
}

export function portInfo(s, port) {
  const def = patternPortDef(s, port);
  const types = ['ns:PatternPort', port.target === 'place' ? 'ns:PlacePort' : 'ns:TransitionPort'];
  if (port.kind === 'in') types.push('ns:InPort');
  if (port.kind === 'out') types.push('ns:OutPort');
  return {
    title: `port ${s.id}:${port.id}`,
    concept: def ? { iri: def.iri, types } : { iri: NS + 'PatternPort', types },
    definition: def ? def.comment : '',
    facts: [
      ['kind (ns:portKind)', port.kind],
      ['target (ns:portTarget)', port.target],
      [port.target === 'place' ? 'place' : 'transition', port.place || port.transition],
      ['schema (ns:portSchema)', port.schema || '(none: transition ports carry no schema)'],
      ['template', def && def.idTemplate ? `${def.idTemplate} (ns:portIdTemplate)` : 'fixed id (ns:portId)'],
    ],
    cites: def ? def.cites : [],
  };
}

export function linkKindInfo(kind) {
  const k = LINK_KINDS[kind];
  return {
    title: `${kind} link`,
    concept: { iri: k.iri, types: ['ns:LinkKind'] },
    definition: k.comment,
    facts: [
      ['from / to', `${k.fromTarget} → ${k.toTarget}`],
      k.forbidsFromPortKind ? ['port direction', `from is not ${k.forbidsFromPortKind}, to is not ${k.forbidsToPortKind}`] : null,
      k.requiresSchemaAgreement ? ['schemas', 'must agree when both ends set one'] : null,
      k.requiresNetKind ? ['net kinds', `both in {${k.requiresNetKind.join(', ')}}`] : null,
      k.forbidsNetKind ? ['net kinds', `neither is ${k.forbidsNetKind.join(', ')}`] : null,
      k.contextual ? ['category theory', 'outside the free-SMC fragment (ROADMAP Phase 6): drawn and flagged, no functorial semantics claimed'] : null,
    ].filter(Boolean),
    cites: [...k.cites, LINK_STYLE_CITE],
  };
}

export function linkInfo(link, byId) {
  const k = LINK_KINDS[link.kind];
  const idiom = link.idiom ? IDIOMS.find((i) => i.key === link.idiom) : null;
  const fs = byId[link.from.subnet], ts = byId[link.to.subnet];
  const fp = fs?.ports.find((p) => p.id === link.from.port), tp = ts?.ports.find((p) => p.id === link.to.port);
  return {
    title: `${link.kind} link ${link.from.subnet}:${link.from.port} → ${link.to.subnet}:${link.to.port}`,
    concept: idiom ? { iri: idiom.iri, types: ['ns:CompositionIdiom', `ns:linkKind lk:${link.kind}`] } : { iri: k.iri, types: ['ns:PatternLink', `ns:linkKind lk:${link.kind}`] },
    definition: idiom ? idiom.rationale : k.comment,
    facts: [
      ['link kind', `lk:${link.kind}: ${k.comment}`],
      ['joins', `${fp ? fp.place || fp.transition : '?'} (${fs?.id}) and ${tp ? tp.place || tp.transition : '?'} (${ts?.id})`],
      ['asserted by', idiom ? `${idiom.assertedBy} (an idiom: a wiring the source suggests; legality is go-pflow's)` : 'drawn on this page; legality is go-pflow\'s'],
    ],
    caveats: idiom && idiom.caveat ? [idiom.caveat] : [],
    cites: [...(idiom ? idiom.cites : []), ...k.cites],
  };
}

export function placeInfo(s, placeId) {
  const p = s.places.find((x) => x.id === placeId);
  const ports = s.ports.filter((q) => q.place === placeId).map((q) => q.id);
  return {
    title: `place ${s.id}/${placeId}`,
    concept: { iri: NS + 'Place', types: ['ns:Place'] },
    definition: p?.description || '',
    facts: [
      ['initial', p?.initial ?? 0],
      ['capacity', p?.capacity ? p.capacity : '0 (unbounded)'],
      ['exported', p?.exported ? `yes (ports: ${ports.join(', ') || 'none'})` : 'no: inside the boundary'],
    ],
    cites: s.cites || [],
  };
}

export function transitionInfo(s, tid) {
  const t = s.transitions.find((x) => x.id === tid);
  const ports = s.ports.filter((q) => q.transition === tid).map((q) => q.id);
  return {
    title: `transition ${s.id}/${tid}`,
    concept: { iri: NS + 'Transition', types: ['ns:Transition'] },
    definition: t?.description || '',
    facts: [['ports', ports.join(', ') || 'none: inside the boundary']],
    cites: s.cites || [],
  };
}

export function flatPlaceInfo(p) {
  return {
    title: `flat place ${p.id}`,
    concept: { iri: NS + 'Place', types: ['ns:Place'] },
    definition: p.description || '',
    facts: [
      ['members', p.members.join(', ')],
      ['initial', p.initial],
      ['capacity', p.capacity || '0 (unbounded)'],
      p.members.length > 1 ? ['fused', 'a wire: places fused by token/data links; initial markings summed'] : null,
    ].filter(Boolean),
    cites: FLATTEN_CITES,
  };
}

export function flatTransitionInfo(t) {
  return {
    title: `flat transition ${t.id}`,
    concept: { iri: NS + 'Transition', types: ['ns:Transition'] },
    definition: t.description || '',
    facts: [
      ['members', t.members.join(', ')],
      t.members.length > 1 ? ['fused', 'one rendezvous: pre/postset is the union of the members\', so it fires only when every member could'] : null,
    ].filter(Boolean),
    cites: FLATTEN_CITES,
  };
}

export function invariantInfo(s, c) {
  const p = PATTERNS[s.pattern];
  const inv = p.invariants.find((i) => c.id === i.id || c.id.startsWith(i.id.replace('<step>', '')) || (i.id.includes('<') && c.id.startsWith(i.id.split('<')[0])));
  return {
    title: `invariant ${s.id}/${c.id}`,
    concept: inv ? { iri: `https://ontology.pflow.xyz/pattern/${inv.key}`, types: ['ns:PatternInvariant'] } : { iri: NS + 'PatternInvariant', types: ['ns:PatternInvariant'] },
    definition: c.expr,
    facts: inv ? [['kind', inv.kind], ['as the ontology states it', inv.expr], ['status', 'declared by the constructor, not proved here (sim_verify / go-pflow verify decide)']] : [],
    cites: inv ? inv.cites : [],
  };
}

export function pieceInfo(name) {
  const p = pieceByName[name];
  if (!p) return { title: name };
  const status = { built: `built (pflow-rs @${PLAN_RS_REV}, plan.pieces)`, reserved: 'reserved: named only to be refused', proposed: 'PROPOSED in the ontology ROADMAP (approved 2026-10-27); pflow-rs refuses it as unknown' }[p.status] || p.status;
  return {
    title: `${p.kind.toLowerCase()} piece ${name}`,
    concept: { iri: `https://ontology.pflow.xyz/ns#SearchPiece`, types: ['ns:SearchPiece (PROPOSED vocabulary, ROADMAP Slice A)'] },
    definition: p.doc,
    facts: [
      ['kind', p.kind],
      ['status', status],
      ['contract (ROADMAP ct:*)', p.contract],
      p.decisive !== undefined ? ['decisive', p.decisive ? 'yes: a nonzero key settles the rank (top tier)' : 'no'] : null,
      p.reads ? ['reads', p.reads] : null,
      p.needsGoals ? ['needs', 'the net\'s goals (Connect-4 declares them)'] : null,
    ].filter(Boolean),
    note: 'ns:SearchPiece and the ct:* contracts are PROPOSED vocabulary (ontology ROADMAP Phase 5); the names, kinds, status and refusals are pflow-rs\'s (plan.pieces, plan.slot_candidates).',
    cites: p.cites,
  };
}

export function slotInfo(slotId) {
  const s = SLOTS.find((x) => x.id === slotId);
  return {
    title: `slot: ${s.label}`,
    concept: { iri: 'https://ontology.pflow.xyz/ns#SearchPieceKind', types: [s.designed ? 'designed, not built' : `takes ${s.accepts} pieces`] },
    definition: s.designed ? 'A slot the design has and plan.rs does not: shown, never fillable.' : `SearchPlan field "${s.field}".`,
    cites: s.cites,
  };
}

export const SEARCH = SEARCH_CITES;
export const PLAN_EXAMPLE_CITE = CONNECT4_EXACT_CITE;
export { ttl };
