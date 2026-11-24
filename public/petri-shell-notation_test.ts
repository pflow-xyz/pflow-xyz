// Unit tests of the notation panel's DOM-free parts (petri-shell-notation.js). The panel in a page is driven by
// scripts/shell-smoke.ts against the real /api/notation.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { lineLit, lineTokens, linesMentioning, notationRequest, toShellDiagnostics } from "./petri-shell-notation.js";
import { parseTarget } from "./petri-shell.js";

const TEXT = `#! pflow 1
net "Bounded buffer"
place slots = 3 cap 3 @ 100, 100
place "two words" cap 3
transition produce @ 365, 113
# produce is mentioned in this comment only
slots -> produce -> "two words"
`;

Deno.test("lineTokens: names and quoted ids, comments ignored", () => {
    assertEquals([...lineTokens('slots -> produce -> "two words"')], ["slots", "produce", "two words"]);
    assertEquals([...lineTokens("# produce only in a comment")], []);
    assertEquals([...lineTokens("place a = 1 # a comment about b")].includes("b"), false);
});

Deno.test("linesMentioning: every line that names the id, never a comment", () => {
    assertEquals(linesMentioning(TEXT, "produce"), [5, 7]);
    assertEquals(linesMentioning(TEXT, "two words"), [4, 7]);
    assertEquals(linesMentioning(TEXT, "nothing"), []);
});

Deno.test("lineLit: node, line and range targets, as the shell parses them", () => {
    const lines = TEXT.split("\n");
    const lit = (ts: string[]) => lines.map((ln, i) => lineLit(ts.map(parseTarget).filter(Boolean), i + 1, lineTokens(ln)) ? i + 1 : 0).filter(Boolean);
    assertEquals(lit(["node:slots"]), [3, 7]);
    assertEquals(lit(["line:2"]), [2]);
    assertEquals(lit(["range:3-4", "node:produce"]), [3, 4, 5, 7]);
    assertEquals(lit([]), []);
});

Deno.test("toShellDiagnostics: the endpoint's diagnostics in the shape the Diagnostics panel takes", () => {
    assertEquals(toShellDiagnostics([
        { severity: "error", message: "no place nowhere", source: "check", line: 5, col: 6, help: "declare it" },
        { severity: "warn", message: "may deadlock", line: 2, col: 1, nodes: ["t1"] },
        { severity: "weird", message: "x" },
    ]), [
        { severity: "error", message: "no place nowhere (declare it)", line: 5, col: 6 },
        { severity: "warn", message: "may deadlock", line: 2, col: 1, nodes: ["t1"] },
        { severity: "info", message: "x" },
    ]);
    assertEquals(toShellDiagnostics(null), []);
});

Deno.test("notationRequest: posts JSON, returns the answer, rejects with the server's words", async () => {
    const seen: any[] = [];
    const ok = async (url: string, init: any) => { seen.push([url, init.method, JSON.parse(init.body)]); return new Response(JSON.stringify({ text: "x" }), { status: 200 }); };
    assertEquals(await notationRequest({ net: { places: {} } }, { fetchImpl: ok as any }), { text: "x" });
    assertEquals(seen, [["/api/notation", "POST", { net: { places: {} } }]]);
    const bad = async () => new Response(JSON.stringify({ error: "at most 256 KiB" }), { status: 413 });
    await assertRejects(() => notationRequest({ text: "" }, { fetchImpl: bad as any }), Error, "256 KiB");
});
