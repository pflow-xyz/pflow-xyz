// Shared by gen_flat.ts and flatten_parity_test.ts: the three catalog
// compositions, and the two projections that make a registry result
// comparable to go-pflow's.

export const CASES = [
  { name: "catalog-default", open: {}, clearLinks: false },
  { name: "catalog-extras", open: { instances: ["orders", "workers", "payment", "payment2", "orders2", "workers2"] }, clearLinks: false },
  { name: "catalog-unlinked", open: {}, clearLinks: true },
];

// deno-lint-ignore no-explicit-any
type J = any;

const drop = (o: J, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** bundle.state as a metamodel.Bundle (go-pflow's JSON), the shape both Flattens consume. */
export function bundleOf(state: J, name: string): J {
  return {
    "@context": "https://pflow.xyz/schema",
    "@type": "PetriNetBundle",
    name,
    subnets: state.subnets.map((s: J) => ({
      "@type": "PetriNet",
      id: s.id,
      net_type: s.net_type,
      model: {
        name: s.model_name,
        places: s.places,
        transitions: s.transitions,
        arcs: s.arcs,
        ...(s.constraints && s.constraints.length ? { constraints: s.constraints } : {}),
      },
      ports: s.ports.map((p: J) => drop(p, ["pattern_port"])),
    })),
    links: state.links.map((l: J) => drop(l, ["index", "key", "idiom", "leak"])),
  };
}

/**
 * A flat net reduced to what must agree: places (id, initial, capacity),
 * transitions (id, and for a fused one its members), and arcs (from, to,
 * weight, type), each sorted. Descriptions and display fields are not compared.
 */
export function flatOf(f: J): J {
  const sortBy = (a: J[], k: (x: J) => string) => [...a].sort((x, y) => (k(x) < k(y) ? -1 : k(x) > k(y) ? 1 : 0));
  return {
    places: sortBy(f.places.map((p: J) => ({ id: p.id, initial: p.initial ?? 0, capacity: p.capacity ?? 0 })), (p) => p.id),
    transitions: sortBy(f.transitions.map((t: J) => ({ id: t.id, members: [...(t.members ?? [t.id])].sort() })), (t) => t.id),
    arcs: sortBy(f.arcs.map((a: J) => ({ from: a.from, to: a.to, weight: a.weight || 1, type: a.type ?? "" })), (a) => `${a.from}\u0000${a.to}\u0000${a.type}\u0000${a.weight}`),
  };
}
