import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderMarkdown } from "./petri-markdown.js";

Deno.test("markdown: bold and code render, no raw markers are left", () => {
    const h = renderMarkdown("**Plan**: run `analysis.verify` then `analysis.reachability`.\n\n**Verdict**\n- safe\n- bounded");
    assertEquals(h, "<p><strong>Plan</strong>: run <code>analysis.verify</code> then <code>analysis.reachability</code>.</p><p><strong>Verdict</strong></p><ul><li>safe</li><li>bounded</li></ul>");
    assert(!h.includes("**") && !h.includes("`"));
});

Deno.test("markdown: replies cannot inject markup", () => {
    const h = renderMarkdown("<img src=x onerror=alert(1)> **ok** [x](javascript:alert(1)) [y](https://pflow.xyz)");
    assert(!h.includes("<img") && h.includes("&lt;img"), h);
    assert(!h.includes('href="javascript'), h);
    assert(h.includes('<a href="https://pflow.xyz"'), h);
});

Deno.test("markdown: numbered lists, fences, headings; emphasis stays out of code and snake_case", () => {
    assertEquals(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
    assertEquals(renderMarkdown("```\nx < 1 **no**\n```"), "<pre><code>x &lt; 1 **no**</code></pre>");
    assertEquals(renderMarkdown("## Result"), "<h4>Result</h4>");
    assertEquals(renderMarkdown("baristas_free and in_service"), "<p>baristas_free and in_service</p>");
    assertEquals(renderMarkdown("1 * 2 * 3"), "<p>1 * 2 * 3</p>");
});
