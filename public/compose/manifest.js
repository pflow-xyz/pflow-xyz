// The scene manifest: what a view drew, for the parity contract with
// pflow-native's egui renderer (pflow-native docs/composition-views-scene.md).
//
// A view collects it WHILE it draws: each call that draws an element listed in
// the contract also calls ctx.emit(kind, id, attrs). It is never recomputed
// from the model on the side. Coordinates, colours and fonts are out of scope;
// the elements drawn and what each one says are in scope.
//
//   manifest = {view, example, state, elements: [{kind, id, attrs}]}
//   sorted by (kind, id), no duplicates; attrs hold only the contract's
//   fields, arrays sorted, numbers integers.

const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm).sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  if (typeof v === 'number') return Math.trunc(v);
  if (v === undefined || v === null) return '';
  return v;
};

export function makeManifest(view, example, stateId) {
  const byKey = new Map();
  const conflicts = [];
  return {
    /** Record one drawn element. A second emit of the same (kind, id) must say the same. */
    emit(kind, id, attrs = {}) {
      const a = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, norm(v)]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
      const key = `${kind}\u0000${id}`;
      const prev = byKey.get(key);
      if (prev) {
        if (JSON.stringify(prev.attrs) !== JSON.stringify(a)) conflicts.push({ kind, id, first: prev.attrs, again: a });
        return;
      }
      byKey.set(key, { kind, id: String(id), attrs: a });
    },
    conflicts,
    result() {
      const elements = [...byKey.values()].sort((x, y) => (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      return { view, example, state: stateId, elements };
    },
  };
}

/** A manifest sink that records nothing (the page, when no one asked for one). */
export const NO_MANIFEST = { emit() {}, conflicts: [], result() { return null; } };
