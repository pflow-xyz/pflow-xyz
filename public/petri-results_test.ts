import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { barsModel, renderArtifact } from "./petri-results.js";

// analysis.diagnose's bars: `value` is the BASELINE on every row; a "+1 token"
// knob has only `hi`. The label is each knob's own influence, and a sink's is 0.
const diagnose = {
    kind: "bars", value_label: "abandoned at t=10",
    bars: [
        { name: "rate customer_arrives", value: 1.0654, lo: 0.3357, hi: 2.2765 },
        { name: "rate finish_service", value: 1.0654, lo: 1.5987, hi: 0.8247 },
        { name: "+1 baristas_free", value: 1.0654, hi: 0.5811 },
        { name: "+1 served", value: 1.0654, hi: 1.0654 },
    ],
};

Deno.test("bars: a tornado labels each knob with its own influence, not the shared baseline", () => {
    const rows = barsModel(diagnose);
    assertEquals(rows.map((r: any) => r.label), ["+1.9408", "-0.774", "-0.4843", "0"]);
    assert(new Set(rows.map((r: any) => r.label)).size === rows.length, "no two rows share a label");
});

Deno.test("bars: a sink (+1 served) draws an empty bar centred on the baseline, not a bar from 0 to the baseline", () => {
    const rows = barsModel(diagnose);
    const served = rows[3];
    assertEquals([served.from, served.to], [0, 0]);
    // +1 token: from the baseline to the new value
    assertEquals(rows[2].to, 0);
    assert(rows[2].from < 0);
});

Deno.test("bars: value labels sit right of the plot, clear of every bar", () => {
    const { html } = renderArtifact({}, { id: "a1", title: "t", data: diagnose });
    const w = +/viewBox="0 0 (\d+)/.exec(html)![1];
    const plotRight = 200 + 320;
    for (const m of html.matchAll(/<rect x="([\d.]+)" y="\d+" width="([\d.]+)"/g)) assert(+m[1] + +m[2] <= plotRight, "bar inside the plot area");
    for (const m of html.matchAll(/<text x="([\d.]+)"[^>]*class="pv-bars-value"/g)) assert(+m[1] > plotRight && +m[1] <= w, "label past the plot");
});

Deno.test("bars: plain bars (no hi) run from 0 to their value", () => {
    const rows = barsModel({ bars: [{ name: "a", value: 3 }, { name: "b", value: -2 }] });
    assertEquals(rows.map((r: any) => [r.from, r.to, r.label]), [[0, 3, "3"], [-2, 0, "-2"]]);
});
