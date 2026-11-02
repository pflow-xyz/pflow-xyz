// The landing page's example cards (docs/design/agent-first-analysis.md 16.3, steps H3 and H4): public/examples.json
// holds a recorded view per card, and this replays every one of them. An engine change that alters what a card opens
// to fails here, and is reviewed, instead of showing a visitor a different answer under the same words.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_ROUNDING, decodeView, replayAllowed, replayViewSpec, sandboxRegistry, validateViewSpec } from "./petri-viewspec.js";
import { defaultVersions } from "./petri-provenance.js";
import { loadEngine } from "./petri-wasm.js";
import { BEGIN, END, canvasHref, patch, payloadsFor, renderBlock, viewHref } from "../scripts/gen-example-cards.mjs";
import { PLAN, record } from "../scripts/record-example-views.mjs";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()), storage: null });

const file = JSON.parse(await Deno.readTextFile(new URL("./examples.json", import.meta.url)));
const examples: any[] = file.examples;
const html = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const IDS = ["coffee-shop", "tic-tac-toe", "enzyme-kinetics", "predator-prey", "producer-consumer", "usdc-bridge"];

const sha256 = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (e: any) => Deno.readFile(new URL(`../${e.file}`, import.meta.url));

Deno.test("examples.json: the six cards, each with what a card needs", () => {
    assertEquals(examples.map((e) => e.id), IDS);
    assertEquals(new Set(examples.map((e) => e.cid)).size, 6);
    for (const e of examples) {
        for (const k of ["id", "title", "cid", "file", "sha256", "blurb", "opensTo", "goal", "payload"]) assert(typeof e[k] === "string" && e[k], `${e.id}.${k}`);
        assert(e.file.startsWith("examples/landing/") && e.file.endsWith(".jsonld"), e.file);
        assert(/^[0-9a-f]{64}$/.test(e.sha256), `${e.id}: sha256`);
        assert(e.cid.startsWith("z4EBG9j"), `${e.id}: the card's CID as served`);
        assert(!/^opens to/i.test(e.opensTo), "the card adds the label");
        assert(!e.opensTo.includes("\n"), "one line");
        assertEquals(e.spec["@type"], "ViewSpec");
        assertEquals(e.spec.net, e.cid, `${e.id}: the spec names the card's net`);
        assertEquals(e.spec.view, e.goal);
        assertEquals(e.spec.note, null, "no model wrote these: there is no assistant's note to label");
        assertEquals(e.spec.expect.rounding, DEFAULT_ROUNDING);
        assert(e.spec.expect.artifacts.length >= 1, `${e.id}: a view with no digest could not be checked`);
    }
});

Deno.test("examples.json: each net file is the one that was recorded against (sha256 of its bytes), and carries the card's CID", async () => {
    for (const e of examples) {
        const bytes = await bytesOf(e);
        assertEquals(await sha256(bytes), e.sha256, `${e.id}: ${e.file} changed; re-record with scripts/record-example-views.mjs and review every view`);
        const net = JSON.parse(new TextDecoder().decode(bytes));
        // Not asserted: that the CID recomputes. These nets were stored under an older context and do not.
        assertEquals(net["@id"], e.cid, `${e.id}: the file's @id`);
    }
});

Deno.test("examples.json: every spec validates, and every call in it is one a link may run", async () => {
    for (const e of examples) {
        const net = JSON.parse(new TextDecoder().decode(await bytesOf(e)));
        const reg = sandboxRegistry(net);
        const v = validateViewSpec(e.spec, reg, { model: net });
        assertEquals([v.ok, v.errors, v.refused, v.unknown], [true, [], [], []], e.id);
        for (const c of e.spec.calls) assert(replayAllowed(c.command, c.args), `${e.id}: ${c.command} is not replay-allowed`);
    }
});

Deno.test("examples.json: every curated view replays to the digests it was recorded with", async () => {
    for (const e of examples) {
        const net = JSON.parse(new TextDecoder().decode(await bytesOf(e)));
        const run: any = await replayViewSpec(e.spec, sandboxRegistry(net), { versions: defaultVersions() });
        assertEquals(run.errors, [], e.id);
        assertEquals(run.steps.filter((s: any) => s.error || s.skipped || s.refused).length, 0, `${e.id}: a call did not run`);
        assertEquals(run.drift.differed.map((d: any) => ({ i: d.index, want: d.expected, got: d.actual })), [], `${e.id}: the view now differs from the recording; if the change is wanted, re-record and review what the card says it opens to`);
        assertEquals(run.drift.unchecked, [], e.id);
        assertEquals(run.drift.matched.length, e.spec.expect.artifacts.length, e.id);
        assertEquals([run.ok, run.mutated, run.partial], [true, false, false], e.id);
    }
});

Deno.test("examples.json: the check has teeth: one flipped digest is caught, naming the result", async () => {
    const e = structuredClone(examples[0]);
    const d = e.spec.expect.artifacts[0];
    e.spec.expect.artifacts[0] = d.replace(/.$/, d.endsWith("0") ? "1" : "0");
    const net = JSON.parse(new TextDecoder().decode(await bytesOf(e)));
    const run: any = await replayViewSpec(e.spec, sandboxRegistry(net));
    assertEquals(run.drift.differed.length, 1);
    assertEquals(run.drift.differed[0].index, 0);
});

Deno.test("examples.json: a fresh recording gives the same file: the Opens-to lines still follow from what the engine shows", async () => {
    const fresh = await record();
    assertEquals(fresh, file, "public/examples.json is stale: run node scripts/record-example-views.mjs, review the diff (every opensTo line is an editorial claim), and commit it with public/index.html (node scripts/gen-example-cards.mjs)");
    assertEquals(PLAN.map((p: any) => p.id), IDS);
});

Deno.test("index.html: the cards are the examples, in order, written by scripts/gen-example-cards.mjs", async () => {
    const ids = [...html.matchAll(/<div class="model-card" data-example="([^"]+)"/g)].map((m) => m[1]);
    assertEquals(ids, examples.map((e) => e.id), "the cards on the page and the examples in examples.json have drifted apart");
    const payloads = payloadsFor(examples);
    assertEquals(html, patch(html, renderBlock(examples, payloads)), "public/index.html is not what scripts/gen-example-cards.mjs writes: run node scripts/gen-example-cards.mjs");
    assert(html.includes(BEGIN) && html.includes(END));
});

Deno.test("index.html: a card opens its view; 'Open the canvas' opens the net alone; both are plain links", async () => {
    const block = html.slice(html.indexOf(BEGIN), html.indexOf(END));
    for (const e of examples) {
        const card = block.slice(block.indexOf(`data-example="${e.id}"`)).split("</div>\n            <div class=\"model-card\"")[0];
        const main = /<a class="model-card-main" href="([^"]+)"/.exec(card)![1].replaceAll("&amp;", "&");
        const canvas = /<a class="model-card-canvas" href="([^"]+)">Open the canvas<\/a>/.exec(card)![1].replaceAll("&amp;", "&");
        // the old href, unchanged: what the card did before it opened a view
        assertEquals(canvas, canvasHref(e));
        assertEquals(canvas, `/?cid=${e.cid}&title=${encodeURIComponent(e.title).replace(/%20/g, "+")}`);
        assert(main.startsWith(`${canvas}#view=`), `${e.id}: the view link is the canvas link plus #view=`);
        const payload = main.slice(main.indexOf("#view=") + 6);
        assertEquals(main, viewHref(e, payload));
        // the payload is the recorded spec, byte for byte once decoded
        const d: any = await decodeView(payload, { net: e.cid });
        assertEquals(d.ok, true);
        assertEquals(d.spec, e.spec);
        assertStringIncludes(card, `Opens to: ${e.opensTo.replaceAll("&", "&amp;")}`);
        assertStringIncludes(card, `<img alt="${e.title}" src="/img/${e.cid}.svg"`);
        assertStringIncludes(card, e.blurb, "the card keeps its text");
        assert(!/onclick|javascript:/i.test(card), "plain links: they work with scripts off");
    }
});

Deno.test("index.html: no script rebuilds a card's URL (it would drop the #view=); a deep link still skips the landing", () => {
    assert(!html.includes("querySelectorAll('.model-card')"), "the old click handler built /?cid=... from data-cid and dropped the hash");
    assert(html.includes("params.has('cid')"), "?cid= (with or without a hash) skips the hero");
});

Deno.test("generate: patch is idempotent, refuses a page without the markers, and the cards escape what they print", async () => {
    const payloads = payloadsFor(examples);
    const block = renderBlock(examples, payloads);
    assertEquals(patch(patch(html, block), block), patch(html, block));
    let threw = false;
    try { patch("<html></html>", block); } catch (e) { threw = String((e as Error).message).includes("markers"); }
    assert(threw);
    const evil = [{ ...examples[0], title: 'A"B<script>', blurb: "<b>x</b>", opensTo: "1 < 2 & 3" }];
    const out = renderBlock(evil, { [evil[0].id]: "AAAA" });
    assert(!out.includes("<script>") && !out.includes("<b>x</b>"));
    assertStringIncludes(out, "Opens to: 1 &lt; 2 &amp; 3");
    assertNotEquals(out, block);
});
