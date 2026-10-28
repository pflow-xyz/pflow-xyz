// gen_flat.ts — writes parity/model/flat/*.json: for three catalog compositions,
// the composition as a metamodel.Bundle (read from the wasm's bundle.state) and
// the flat net the wasm's bundle.flatten makes of it, normalised for comparison.
//
// The Go test (internal/model/flatten_parity_test.go) flattens the same bundle
// with go-pflow's Bundle.Flatten and compares; flatten_parity_test.ts checks
// that the wasm still produces the same bundle and flat net. Both against one
// file, so green on both is "go-pflow's flat net equals the wasm's".
//
//   deno run --allow-read --allow-write=parity/model/flat parity/model/gen_flat.ts
import { loadEngine } from "../../public/petri-wasm.js";
import { bundleOf, flatOf, CASES } from "./flat_lib.ts";

const gz = await Deno.readFile(new URL("../../public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const wasm = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const { glue } = await loadEngine({ bytes: wasm });

for (const c of CASES) {
  const engine = new glue.Engine();
  const call = (id: string, args: unknown = {}) => JSON.parse(engine.execute(id, JSON.stringify(args)));
  call("bundle.open", c.open);
  if (c.clearLinks) call("bundle.clear_links");
  const bundle = bundleOf(call("bundle.state"), c.name);
  const flat = flatOf(call("bundle.flatten"));
  await Deno.writeTextFile(new URL(`./flat/${c.name}.bundle.json`, import.meta.url), JSON.stringify(bundle, null, 2) + "\n");
  await Deno.writeTextFile(new URL(`./flat/${c.name}.flat.json`, import.meta.url), JSON.stringify(flat, null, 2) + "\n");
  console.log(c.name, flat.places.length, "places", flat.transitions.length, "transitions", flat.arcs.length, "arcs");
}
