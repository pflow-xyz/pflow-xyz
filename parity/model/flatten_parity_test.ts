// The wasm side of the Flatten parity: bundle.open + bundle.flatten still make
// the bundles and flat nets in parity/model/flat/ (written by gen_flat.ts),
// which go-pflow's Bundle.Flatten is held to by
// internal/model/flatten_parity_test.go. One golden file, two implementations.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadEngine } from "../../public/petri-wasm.js";
import { bundleOf, flatOf, CASES } from "./flat_lib.ts";

const gz = await Deno.readFile(new URL("../../public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const wasm = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const { glue } = await loadEngine({ bytes: wasm });
const read = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`./flat/${f}`, import.meta.url)));

for (const c of CASES) {
  Deno.test(`wasm bundle.flatten of ${c.name} is the flat net go-pflow is held to`, async () => {
    const engine = new glue.Engine();
    const call = (id: string, args: unknown = {}) => JSON.parse(engine.execute(id, JSON.stringify(args)));
    call("bundle.open", c.open);
    if (c.clearLinks) call("bundle.clear_links");
    assertEquals(bundleOf(call("bundle.state"), c.name), await read(`${c.name}.bundle.json`), "the bundle the registry holds drifted: re-run gen_flat.ts and the Go test");
    assertEquals(flatOf(call("bundle.flatten")), await read(`${c.name}.flat.json`), "the flat net drifted: re-run gen_flat.ts and the Go test");
  });
}
