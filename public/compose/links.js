// The page's links, apart from the DOM: what the URL hash says and how to write it.
//
//   #view=<id>&ex=<orders|connect4>              a view of an example
//     &inst=orders,workers,payment,payment2      the instances, when not the default ones
//     &links=event~orders:dequeue~workers:acquire,…   the links, when not the default ones (empty: none)
//     &plan=<base64url of the plan JSON>         the search plan, when not the default one
//     &level=… &lens=… &law=… …                  a view's own parameters: kept, not read here
//
// Whether a value is a legal composition is never decided here: state.js gives it to the registry.

const EXTRA = new Set(['view', 'ex', 'inst', 'links', 'plan']);

const end = (ref) => `${ref.subnet}:${ref.port}`;
const parseEnd = (s) => {
  const i = s.indexOf(':'); // subnet ids hold no colon; port ids may
  if (i <= 0 || i === s.length - 1) throw new Error(`"${s}" is not subnet:port`);
  return { subnet: s.slice(0, i), port: s.slice(i + 1) };
};

export const encodeLinks = (links) => links.map((l) => `${l.kind}~${end(l.from)}~${end(l.to)}`).join(',');

/** The links an encoded list names; throws on text that is not one. */
export function decodeLinks(text) {
  if (!text) return [];
  return text.split(',').map((one) => {
    const parts = one.split('~');
    if (parts.length !== 3) throw new Error(`"${one}" is not kind~from~to`);
    return { kind: parts[0], from: parseEnd(parts[1]), to: parseEnd(parts[2]) };
  });
}

export function encodePlan(json) {
  const bin = String.fromCharCode(...new TextEncoder().encode(json));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The plan JSON an encoded plan holds, parsed; throws on text that is not one. */
export function decodePlan(text) {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/** What a hash says: {view, ex, inst, links, plan, own}. A parameter that is absent is undefined; `own` is the rest. */
export function readLink(hash) {
  const h = new URLSearchParams(String(hash).replace(/^#/, ''));
  const own = [...h].filter(([k]) => !EXTRA.has(k));
  const get = (k) => (h.has(k) ? h.get(k) : undefined);
  return { view: get('view'), ex: get('ex'), inst: get('inst'), links: get('links'), plan: get('plan'), own };
}

/** The hash for those values (the inverse of readLink). `:`, `,` and `~` are legal in a fragment, and stay readable. */
export function writeLink({ view, ex, inst, links, plan, own = [] }) {
  const h = new URLSearchParams();
  for (const [k, v] of [['view', view], ['ex', ex], ['inst', inst], ['links', links], ['plan', plan]]) if (v !== undefined) h.set(k, v);
  for (const [k, v] of own) h.append(k, v);
  return `#${h.toString().replaceAll('%3A', ':').replaceAll('%2C', ',').replaceAll('%7E', '~')}`;
}
