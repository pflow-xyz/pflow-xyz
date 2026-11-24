// The IDE shell's core (petri-shell.js, petri-shell-views.js): the registry, what an event opens, the layout, the
// command filter and the flag; plus a static check that the shell's modules stay clean for a strict CSP.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    LEVELS, MAX_NET_BYTES, MAX_NOTE, parseTarget, Shell as ShellJs, ViewRegistry, closePanel, emptyLayout as emptyLayoutJs, filterCommands, matchScore, movePanel, openPanel,
    planOpen as planOpenJs, resizeDock, sanitizeLayout, shellEnabled,
} from "./petri-shell.js";
import { BUILTIN_VIEWS, registerBuiltins } from "./petri-shell-views.js";

const noop = () => {};
const planOpen: any = planOpenJs;
const emptyLayout: any = emptyLayoutJs;
const Shell: any = ShellJs;
const fresh = () => registerBuiltins(new ViewRegistry());
const net = { "@type": "PetriNet", places: { p: { initial: [1] } }, transitions: { t: {} }, arcs: [] };

Deno.test("registry: validates declarations", () => {
    const r = new ViewRegistry();
    for (const bad of [null, { type: "Bad", kind: "panel", dock: "left", render: noop }, { type: "x", kind: "tab", render: noop },
        { type: "x", kind: "panel", dock: "top", render: noop }, { type: "x", kind: "modal" }]) {
        let threw = false;
        try { r.register(bad as any); } catch { threw = true; }
        assert(threw, JSON.stringify(bad));
    }
    r.register({ type: "ok", kind: "modal", render: noop });
    assert(r.has("ok"));
});

Deno.test("registry: every built-in view is a valid entry, and the tab-push view names are all there", () => {
    const r = fresh();
    assertEquals(BUILTIN_VIEWS.length, r.types().length);
    for (const name of ["canvas", "plot", "reachability", "invariants", "categorical", "notation"]) assert(r.has(name), name);
    assertEquals(r.get("categorical")!.kind, "modal");
    assertEquals(r.get("plot")!.dock, "bottom");
    assertEquals(r.get("notation")!.dock, "center");
});

Deno.test("registry: a later registration replaces (the notation panel overrides the stand-in)", () => {
    const r = fresh();
    r.register({ type: "notation", kind: "panel", dock: "center", title: "pflow notation", render: noop });
    assertEquals(r.get("notation")!.title, "pflow notation");
});

Deno.test("planOpen: refuses what is malformed, bounds what is big", () => {
    const r = fresh();
    assertFalse(planOpen(r, null).ok);
    assertFalse(planOpen(r, { view: "Plot" }).ok);
    assertFalse(planOpen(r, { view: "plot", params: [] }).ok);
    assertFalse(planOpen(r, { view: "plot", net, cid: "zb" }).ok);
    assertFalse(planOpen(r, { view: "plot", net: { big: "x".repeat(MAX_NET_BYTES) } }).ok);
    const ok = planOpen(r, { view: "plot", note: "n".repeat(MAX_NOTE + 50) });
    assert(ok.ok);
    assertEquals(ok.plan.payload.note.length, MAX_NOTE);
});

Deno.test("planOpen: an unregistered view degrades to the result modal, with its note", () => {
    const r = fresh();
    const p = planOpen(r, { view: "flamegraph", note: "hot path: txn3", params: { depth: 4 } });
    assert(p.ok);
    assertEquals(p.plan.type, "result");
    assertEquals(p.plan.kind, "modal");
    assert(p.plan.fallback);
    assertEquals(p.plan.payload.title, "flamegraph");
    assertEquals(p.plan.payload.text, "hot path: txn3");
});

Deno.test("planOpen: auto means the event asked for a result", () => {
    const r = fresh();
    assertFalse(planOpen(r, { view: "plot" }).plan.payload.auto);
    assert(planOpen(r, { view: "plot", request_id: "r1" }).plan.payload.auto);
    assert(planOpen(r, { view: "plot", params: { t_end: 5 } }).plan.payload.auto);
    assert(planOpen(r, { view: "plot", net }).plan.payload.auto);
});

Deno.test("Shell: a panel opens in its declared dock, a singleton is reused, a modal replaces a modal", () => {
    const s = new Shell({ registry: fresh() });
    const seen: any[] = [];
    s.subscribe((e: any) => seen.push(e));
    const a = s.open({ view: "plot" });
    assert(a.ok);
    assertEquals(a.dock, "bottom");
    assertEquals(s.layout.docks.bottom.map((p: any) => p.id), ["plot"]);
    s.open({ view: "plot", params: { t_end: 3 } });
    assertEquals(s.layout.docks.bottom.length, 1);
    assertFalse(s.open({ view: "categorical", cid: "zb2rhabcdefgh" }).ok);   // a math view at the model level
    s.setLevel("math");
    s.open({ view: "invariants" });
    assertEquals(s.layout.active.bottom, "invariants");
    assert(s.open({ view: "categorical", cid: "zb2rhabcdefgh" }).ok);
    s.open({ view: "settings" });
    assertEquals(s.modal!.id, "settings");
    assert(seen.some((e) => e.kind === "close" && e.modal && e.replaced));
});

Deno.test("Shell: canvas is pinned: it reveals, never lands in a dock", () => {
    const s = new Shell({ registry: fresh() });
    s.open({ view: "notation" });
    assertEquals(s.layout.active.center, "notation");
    const r = s.open({ view: "canvas", net });
    assert(r.ok);
    assertEquals(s.layout.active.center, null);
    assertEquals(s.layout.docks.center.map((p: any) => p.id), ["notation"]);
    assertEquals(s.layout.phone, "canvas");
});

Deno.test("Shell: stop closes what a push opened, and keeps what the person opened", () => {
    const s = new Shell({ registry: fresh() });
    s.open({ view: "outline" });                         // by hand
    s.open({ view: "plot", request_id: "r1" });          // pushed
    s.open({ view: "settings" });                        // a modal by hand
    assert(s.stop() >= 1);
    assertEquals(s.modal, null);
    assertFalse(s.layout.docks.bottom.some((p: any) => p.id === "plot"));
    assert(s.layout.docks.left.some((p: any) => p.id === "outline"));
});

Deno.test("Shell: a pushed net is never in the persisted layout or the state() report", () => {
    const s = new Shell({ registry: fresh() });
    const secret = { "@type": "PetriNet", places: { SECRET_PLACE_NAME: {} }, transitions: {}, arcs: [] };
    s.open({ view: "plot", net: secret, note: "SECRET_NOTE" });
    assertFalse(s.persist().includes("SECRET"));
    assertFalse(JSON.stringify(s.state()).includes("SECRET"));
    assertEquals(s.state().panels[0].id, "plot");
});

Deno.test("layout: sanitize drops unknown types, docks, duplicates and absurd sizes; clamps", () => {
    const r = fresh();
    const L = sanitizeLayout({
        v: 1,
        docks: { left: [{ id: "outline", type: "outline" }, { id: "outline", type: "outline" }, { id: "evil", type: "nope" }, { id: "m", type: "settings" }, "x"], top: [{ id: "plot", type: "plot" }], bottom: [{ id: "plot", type: "plot" }] },
        active: { left: "ghost", bottom: "plot" }, sizes: { left: 99999, right: -5, bottom: "wide" }, phone: "nonsense",
    }, r);
    assertEquals(L.docks.left.map((p: any) => p.id), ["outline"]);   // a modal type is not a panel
    assertEquals(L.docks.bottom.map((p: any) => p.id), ["plot"]);
    assertEquals(L.active.left, "outline");
    assertEquals(L.sizes.left, 560);
    assertEquals(L.sizes.right, 220);
    assertEquals(L.sizes.bottom, 280);
    assertEquals(L.phone, "canvas");
    assertEquals(sanitizeLayout("garbage", r), emptyLayout());
    assertEquals(sanitizeLayout({ v: 2 }, r), emptyLayout());
});

Deno.test("layout: open, move, close, resize", () => {
    let L: any = emptyLayout();
    L = openPanel(L, { id: "plot", type: "plot", dock: "bottom" });
    L = openPanel(L, { id: "outline", type: "outline", dock: "left" });
    L = movePanel(L, "plot", "right");
    assertEquals(L.docks.right.map((p: any) => p.id), ["plot"]);
    assertEquals(L.docks.bottom.length, 0);
    assertEquals(L.active.bottom, null);
    assertEquals(L.phone, "plot");
    L = closePanel(L, "plot");
    assertEquals(L.phone, "canvas");
    assertEquals(resizeDock(L, "left", 5).sizes.left, 160);
    assertEquals(resizeDock(L, "nope", 5), L);
});

Deno.test("palette: filter ranks prefix, then substring, then subsequence", () => {
    assertEquals(matchScore("", "Anything"), 0);
    assert(matchScore("sim", "Simulation") > matchScore("sim", "Open Simulation"));
    assert(matchScore("sim", "Open Simulation") > matchScore("osn", "Open Simulation"));
    assertEquals(matchScore("zzz", "Open Plot"), -1);
    const s = new Shell({ registry: fresh() });
    s.open({ view: "plot" });
    const cmds = s.commands();
    assert(cmds.some((c: any) => c.id === "view.open.invariants"));
    assert(cmds.some((c: any) => c.id === "view.move.plot.right"));
    assert(cmds.some((c: any) => c.id === "view.reset"));
    assertEquals(filterCommands(cmds, "invari")[0].id, "view.open.invariants");
});

Deno.test("flag: on by default; ?shell=0 opts out and remembers, ?shell=1 opts back in", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    assert(shellEnabled("", store), "a first visit opens the IDE");
    assertFalse(shellEnabled("?shell=0", store));
    assertFalse(shellEnabled("", store), "the opt-out is remembered");
    assert(shellEnabled("?shell=1", store));
    assert(shellEnabled("", store), "and so is the opt back in");
    assert(shellEnabled("", null));               // no storage: the default, this visit
    assertFalse(shellEnabled("?shell=0", null));  // no storage: the query alone decides
    assert(shellEnabled("?shell=1", null));
    mem.set("pflow_shell", "1");                   // a browser that opted in under the old flag stays in
    assert(shellEnabled("", store));
});

Deno.test("strict CSP: the shell's modules use no inline handler, inline style, eval or document.write", async () => {
    for (const f of ["petri-shell.js", "petri-shell-views.js", "petri-shell-ui.js", "petri-shell-boot.js", "petri-shell-notation.js", "petri-shell-guide.js"]) {
        const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
        const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
        for (const [re, why] of [
            [/\son[a-z]+\s*=\s*["'`\\]/i, "an inline event handler attribute"],
            [/\bstyle\s*=\s*["'`\\]/i, "an inline style attribute"],
            [/setAttribute\(\s*['"]style['"]/, "setAttribute('style')"],
            [/\beval\s*\(|new\s+Function\s*\(|\bdocument\.write\s*\(/, "eval / new Function / document.write"],
            [/javascript:/i, "a javascript: URL"],
        ] as [RegExp, string][]) assertFalse(re.test(code), `${f}: ${why}`);
    }
    const css = await Deno.readTextFile(new URL("./petri-shell.css", import.meta.url));
    assertFalse(/#[0-9a-fA-F]{3,8}\b/.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "petri-shell.css: colours come from tokens");
});

Deno.test("levels: a view above the level is refused with what it needs; stepping down allows it; stepping up closes it", () => {
    const s = new Shell({ registry: fresh() });
    const seen: any[] = [];
    s.subscribe((e: any) => seen.push(e));
    assertEquals(s.level, "model");
    const r = s.open({ view: "invariants" });
    assertFalse(r.ok);
    assertEquals(r.needs, "math");
    assert(seen.some((e) => e.kind === "refused" && e.needs === "math" && e.evt.view === "invariants"));
    assert(s.setLevel("math"));
    assert(s.open({ view: "invariants" }).ok);
    s.open({ view: "plot" });
    assert(s.setLevel("outcome"));
    assertFalse(s.layout.docks.bottom.some((p: any) => p.id === "invariants"), "a math panel closes at the outcome level");
    assert(s.layout.docks.bottom.some((p: any) => p.id === "plot"), "an outcome view stays");
    assertFalse(s.open({ view: "outline" }).ok);
    assertFalse(s.setLevel("nonsense"));
    assertEquals(s.state().level, "outcome");
});

Deno.test("levels: the persisted layout keeps the level and drops panels above it", () => {
    const r = fresh();
    const L = sanitizeLayout({ v: 1, level: "outcome", docks: { bottom: [{ id: "plot", type: "plot" }, { id: "invariants", type: "invariants" }] } }, r);
    assertEquals(L.level, "outcome");
    assertEquals(L.docks.bottom.map((p: any) => p.id), ["plot"]);
    assertEquals(sanitizeLayout({ v: 1, level: "galaxy" }, r).level, "model");
    assertEquals([...LEVELS], ["outcome", "model", "math"]);
});

Deno.test("targets: node, line, range, panel, view; anything else is null", () => {
    assertEquals(parseTarget("node:place0"), { kind: "node", id: "place0" });
    assertEquals(parseTarget("line:12"), { kind: "line", line: 12 });
    assertEquals(parseTarget("range:3-9"), { kind: "range", from: 3, to: 9 });
    assertEquals(parseTarget("range:9-3"), null);
    assertEquals(parseTarget("line:0"), null);
    assertEquals(parseTarget("panel:plot"), { kind: "panel", id: "plot" });
    assertEquals(parseTarget("view:reachability"), { kind: "view", type: "reachability" });
    for (const bad of ["", "node:", "x:1", 5, null, "view:Bad Name", "line:1;drop"]) assertEquals(parseTarget(bad as any), null, String(bad));
});

Deno.test("dispatch: one entry for every verb, bad events answer instead of throwing", () => {
    const s = new Shell({ registry: fresh() });
    assert(s.dispatch({ view: "outline" }).ok);                       // type defaults to show
    assert(s.dispatch({ type: "show", view: "plot" }).ok);
    assertEquals(s.dispatch({ type: "level", level: "math" }).level, "math");
    assertFalse(s.dispatch({ type: "level", level: "deep" }).ok);
    assertEquals(s.dispatch({ type: "highlight", targets: ["node:p", "bogus", "line:2"] }).count, 2);
    assertEquals(s.highlights, ["node:p", "line:2"]);
    assertEquals(s.dispatch({ type: "highlight", targets: [] }).count, 0);
    const a = s.dispatch({ type: "annotate", target: "node:p", text: "this place holds the tokens" });
    assert(a.ok);
    assertEquals(s.annotations.length, 1);
    assertEquals(s.highlights, ["node:p"]);
    s.dispatch({ type: "annotate", id: a.id, text: "" });
    assertEquals(s.annotations.length, 0);
    assert(s.dispatch({ type: "focus", target: "panel:plot" }).ok);
    assertFalse(s.dispatch({ type: "focus", target: "panel:ghost" }).ok);
    assert(s.dispatch({ type: "focus", target: "view:reachability" }).ok);
    assertFalse(s.dispatch({ type: "focus", target: "nonsense" }).ok);
    assertFalse(s.dispatch({ type: "explode" }).ok);
    assertFalse(s.dispatch(null as any).ok);
    assertFalse(s.dispatch({ type: "annotate" }).ok);
});

Deno.test("tour: steps run in order, say is narration, controls move, a tour in a tour is refused", () => {
    const s = new Shell({ registry: fresh() });
    assertFalse(s.dispatch({ type: "tour", steps: [] }).ok);
    assertFalse(s.dispatch({ type: "tour", steps: [{ type: "tour", steps: [] }] }).ok);
    assertFalse(s.dispatch({ type: "tour", steps: Array.from({ length: 31 }, () => ({ say: "x" })) }).ok);
    const r = s.dispatch({
        type: "tour", title: "What is a place?",
        steps: [{ say: "Start with the model.", type: "level", level: "model" }, { say: "This is the stock.", type: "highlight", targets: ["node:p"] }, { say: "Now the detail.", type: "level", level: "math" }, { say: "Place invariants.", view: "invariants" }],
    });
    assert(r.ok);
    assertEquals(s.state().tour, { title: "What is a place?", step: 1, of: 4 });
    assertEquals(s.tour!.say, "Start with the model.");
    assert(s.tourNext());
    assertEquals(s.highlights, ["node:p"]);
    assert(s.tourNext());
    assertEquals(s.level, "math");
    assert(s.tourNext());
    assert(s.layout.docks.bottom.some((p: any) => p.id === "invariants"));
    assertFalse(s.tourNext());                       // past the end
    assert(s.tourBack());
    assertEquals(s.dispatch({ type: "tour_control", action: "end" }).ok, true);
    assertEquals(s.tour, null);
    assertEquals(s.state().tour, null);
});

Deno.test("guide: Examples and Connect are modal views in the registry, in the palette, and refused for nothing at any level", async () => {
    const { registerGuide, LINKS, CONNECT_STEPS } = await import("./petri-shell-guide.js");
    const reg = registerGuide(new ViewRegistry());
    for (const t of ["examples", "connect"]) {
        assertEquals(reg.get(t).kind, "modal");
        assertEquals(reg.get(t).level, "outcome", "reachable at every level");
    }
    const shell = new Shell({ registry: reg });
    const ids = shell.commands().map((c: { id: string }) => c.id);
    assert(ids.includes("view.open.examples") && ids.includes("view.open.connect"));
    assertEquals(LINKS.map((l: { title: string }) => l.title).slice(0, 4), ["The book", "The blog", "The ontology", "GitHub"]);
    assert(CONNECT_STEPS.some((s: { copy: string }) => s.copy === "https://pflow.xyz/mcp"));
});
