// The keyboard link machine (a11y-link.js) and the verdict text it shares with the
// pointer path (verdicts.js). Part one drives the machine with small canned
// targets; part two feeds it what the registry says: the vendored wasm, opened
// the way the parity harness opens it, asked bundle.candidates / plan.slot_candidates,
// and the machine walks THOSE verdicts. Nothing in the machine decides a rule, so
// what it announces must be what the registry said, and a commit must be a link
// the registry accepts.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { afterGesture, begin, beginText, noTargetsText, press, targetText } from "./a11y-link.js";
import { errText, portLegalReason, portRefusal, portTargets, slotLegalReason, slotRefusal, slotTargets } from "./verdicts.js";
import { setup } from "../../parity/composition-views/render.js";
import { actions, linkCandidates, slotCandidates, start, subnetsById } from "./state.js";
import { brokenViewText, portLabel, registryFailureText, VIEW_KEYS_OFF } from "./a11y-text.js";
import { initialInspector, reduceInspector } from "./a11y-inspect.js";

const T = (key: string, ok: boolean, reason = ok ? "passed" : "refused", kind: string | null = ok ? "token" : null) => ({ key, label: `label ${key}`, ok, kind, reason });
const k = (key: string, shiftKey = false) => ({ key, shiftKey });

// --- canned -----------------------------------------------------------------------------------

Deno.test("begin: counts lit and refused targets, and names the keys", () => {
  const { state, announce, effects } = begin({ noun: "port", originKey: "port:a:x", originLabel: "a:x", targets: [T("b:1", true), T("b:2", false), T("c:1", true)] });
  assertEquals(effects, []);
  assertEquals(state.legal, ["b:1", "c:1"]);
  assertEquals(state.refused, ["b:2"]);
  assertStringIncludes(announce, "Linking from a:x");
  assertStringIncludes(announce, "2 legal ports lit, 1 refused");
  assertStringIncludes(announce, "Enter links");
  assertStringIncludes(announce, "R says why a refused port is refused");
  assertStringIncludes(announce, "Escape cancels");
});

Deno.test("begin: nothing legal says so and points at R", () => {
  const { state, announce } = begin({ noun: "slot", originKey: "piece:beam", originLabel: "beam", targets: [T("order", false), T("memo", false)] });
  assertEquals(state.legal, []);
  assertStringIncludes(announce, "No legal slot");
  assertStringIncludes(announce, "Press R");
  assert(!announce.includes("Enter links"));
});

Deno.test("Tab and the arrows walk the lit targets only, wrapping", () => {
  let s = begin({ originKey: "o", originLabel: "o", targets: [T("a", true), T("x", false), T("b", true), T("c", true)] }).state;
  const seen: string[] = [];
  for (const key of ["Tab", "ArrowRight", "ArrowDown", "Tab"]) {
    const r = press(s, k(key));
    assert(r.handled);
    assertEquals(r.effects.length, 1);
    seen.push((r.effects[0] as any).key);
    s = r.state;
  }
  assertEquals(seen, ["a", "b", "c", "a"]); // x is refused and never visited; the walk wraps
  for (const key of ["ArrowLeft", "ArrowUp"]) {
    const r = press(s, k(key));
    seen.push((r.effects[0] as any).key);
    s = r.state;
  }
  assertEquals(seen.slice(4), ["c", "b"]);
  const back = press(s, k("Tab", true));
  assertEquals((back.effects[0] as any).key, "a"); // Shift+Tab goes back
  assertEquals((press(s, k("Home")).effects[0] as any).key, "a");
  assertEquals((press(s, k("End")).effects[0] as any).key, "c");
});

Deno.test("a focused lit target announces its verdict and its place in the walk", () => {
  const s = begin({ originKey: "o", originLabel: "o", targets: [T("a", true, "schemas agree"), T("b", true)] }).state;
  const r = press(s, k("Tab"));
  assertStringIncludes(r.announce, "label a: legal, token link. schemas agree. Target 1 of 2. Press Enter to link.");
});

Deno.test("R walks the refused targets and says why each is refused", () => {
  let s = begin({ originKey: "o", originLabel: "o", targets: [T("a", true), T("x", false, "E_X one"), T("y", false, "E_Y two")] }).state;
  let r = press(s, k("r"));
  assertEquals(r.effects, [{ type: "focus", key: "x" }]);
  assertStringIncludes(r.announce, "label x: refused. E_X one. Refused port 1 of 2.");
  s = r.state;
  r = press(s, k("r"));
  assertStringIncludes(r.announce, "E_Y two");
  s = r.state;
  r = press(s, k("r")); // wraps
  assertEquals(r.effects, [{ type: "focus", key: "x" }]);
  r = press(r.state, k("R")); // Shift+R goes back
  assertEquals(r.effects, [{ type: "focus", key: "y" }]);
});

Deno.test("R walks the refused targets forward and Shift+R back, over a list of three or more (two cannot tell the directions apart)", () => {
  const start = begin({ originKey: "o", originLabel: "o", targets: [T("a", true), T("x", false), T("y", false), T("z", false)] }).state;
  const at = (s: any, ev: any) => { const r = press(s, ev); return { s: r.state, key: (r.effects[0] as any).key }; };
  // forward from nowhere: the first, then on, wrapping
  let w = at(start, k("r"));
  assertEquals(w.key, "x");
  w = at(w.s, k("r")); assertEquals(w.key, "y");
  w = at(w.s, k("r")); assertEquals(w.key, "z");
  w = at(w.s, k("r")); assertEquals(w.key, "x", "wraps forward");
  // back from the middle goes to the one before it, not the one after
  w = at(at(start, k("r")).s, k("r")); // on y
  assertEquals(w.key, "y");
  w = at(w.s, k("R")); assertEquals(w.key, "x", "Shift+R goes back");
  w = at(w.s, k("R")); assertEquals(w.key, "z", "wraps backward");
  // a terminal that reports the lower-case key with Shift held means the same
  w = at(w.s, { key: "r", shiftKey: true }); assertEquals(w.key, "y");
  // from nowhere, back starts at the end
  assertEquals(at(start, k("R")).key, "z");
});

Deno.test("a view that draws no target: link mode is not entered, and the text says the view draws none (not that the rules refuse)", () => {
  const r = begin({ noun: "slot", originKey: "piece:threats", originLabel: "threats, order piece", targets: [] });
  assertEquals(r.state.phase, "ended");
  assertEquals(r.effects, []);
  assertEquals(r.announce, "threats, order piece: this view draws no slots to link to, so there is nothing to light. Another view may draw them.");
  assert(!r.announce.includes("refuse"));
  assertEquals(noTargetsText("port", "orders:in").startsWith("orders:in: this view draws no other ports to link to"), true);
  assertEquals(press(r.state, k("r")).handled, false, "after an ended begin the machine takes nothing");
  assertEquals(press(r.state, k("Enter")).handled, false);
});

Deno.test("Enter on a refused target explains and does not link; on a lit one it commits", () => {
  let s = begin({ originKey: "port:o", originLabel: "o", targets: [T("a", true), T("x", false, "E_X one")] }).state;
  s = press(s, k("r")).state;
  let r = press(s, k("Enter"));
  assertEquals(r.effects, []);
  assertStringIncludes(r.announce, "Cannot link to label x: E_X one.");
  assertEquals(r.state.phase, "linking");
  s = press(r.state, k("Tab")).state;
  r = press(s, k(" "));
  assertEquals(r.effects, [{ type: "commit", key: "a" }, { type: "end", focus: "port:o" }]);
  assertEquals(r.state.phase, "ended");
});

Deno.test("Enter before any target is chosen asks for one", () => {
  const s = begin({ originKey: "o", originLabel: "o", targets: [T("a", true)] }).state;
  const r = press(s, k("Enter"));
  assertEquals(r.effects, []);
  assertStringIncludes(r.announce, "Choose a target first");
});

Deno.test("Escape cancels and returns focus to the origin", () => {
  let s = begin({ originKey: "port:o", originLabel: "o", targets: [T("a", true)] }).state;
  s = press(s, k("Tab")).state;
  const r = press(s, k("Escape"));
  assertEquals(r.effects, [{ type: "end", focus: "port:o" }]);
  assertEquals(r.announce, "Linking cancelled.");
  assertEquals(r.state.phase, "ended");
  assertEquals(press(r.state, k("Tab")).handled, false); // after the end the machine takes nothing
});

Deno.test("with no lit target, the walk says so; keys the machine does not own pass through", () => {
  const s = begin({ originKey: "o", originLabel: "o", targets: [T("x", false)] }).state;
  const r = press(s, k("Tab"));
  assertStringIncludes(r.announce, "No legal port");
  assertEquals(r.effects, []);
  assert(!press(s, k("3")).handled);
  assert(!press(s, { key: "Tab", ctrlKey: true }).handled);
  assert(!press(s, { key: "r", metaKey: true }).handled);
  assertStringIncludes(press(s, k("?")).announce, "Linking from o");
});

Deno.test("beginText and targetText are pure functions of the state", () => {
  const { state } = begin({ originKey: "o", originLabel: "o", targets: [T("a", true)] });
  assertEquals(beginText(state), beginText(state));
  assertEquals(targetText(state, "nope"), "");
});

// --- the verdict text the pointer path and the machine share ---------------------------------------

Deno.test("verdicts: the phrases are the registry's, with the link index trimmed", () => {
  assertEquals(errText({ code: "E_X", message: "links[0]: both ends are on subnet" }), "E_X both ends are on subnet");
  assertEquals(errText({ message: "link: nope" }), "nope");
  assertEquals(slotRefusal({ why: "no", rule: "pflow-rs" }), "no (pflow-rs)");
  assertEquals(slotRefusal(undefined), "not a slot");
  assertEquals(portRefusal(undefined), "not a target");
  assertEquals(slotLegalReason({ slot: "order" }), "fits the order slot (pflow-rs accepts the plan: plan.slot_candidates)");
});

Deno.test("verdicts: a refused port reads kind by kind, joined by ' | ' and '; ' (literal)", () => {
  const v = {
    key: "workers:available", ok: false,
    tried: [
      { link: { kind: "token" }, verdict: { errors: [{ code: "E_A", message: "links[0]: one" }, { code: "E_B", message: "two" }] } },
      { link: { kind: "data" }, verdict: { errors: [{ code: "E_C", message: "three" }] } },
    ],
  };
  assertEquals(portRefusal(v), "token: E_A one; E_B two | data: E_C three");
  assertEquals(portTargets([v])[0].reason, "token: E_A one; E_B two | data: E_C three");
  assertEquals(portLegalReason({ verdict: { passed: [{ text: "schemas agree" }, { text: "directions fit" }] } }), "schemas agree; directions fit");
});

Deno.test("verdicts: slot targets carry no link kind, and a legal and a refused slot read as the pointer's tip does", () => {
  const cands = [{ slot: "order", ok: true }, { slot: "memo", ok: false, why: "memo takes memo pieces", rule: "pflow-rs" }, { slot: "off", ok: true }];
  const t = slotTargets(cands, { has: (k: string) => k !== "off", label: (k: string) => `${k} slot` });
  assertEquals(t.map((x: any) => x.key), ["order", "memo"], "a slot the view does not draw is left out");
  for (const x of t) assertEquals(x.kind, null, "a slot has no link kind");
  assertEquals(t[0], { key: "order", label: "order slot", ok: true, kind: null, reason: "fits the order slot (pflow-rs accepts the plan: plan.slot_candidates)" });
  assertEquals(t[1], { key: "memo", label: "memo slot", ok: false, kind: null, reason: "memo takes memo pieces (pflow-rs)" });
  // and a port target carries its kind only when legal
  const p = portTargets([{ key: "a:b", ok: true, link: { kind: "token" }, verdict: { passed: [{ text: "ok" }] } }, { key: "c:d", ok: false, tried: [] }]);
  assertEquals([p[0].kind, p[1].kind], ["token", null]);
});

// --- the registry's own verdicts -------------------------------------------------------------------

await setup();
const REGISTRY_CODES = ["PAGE_SAME_SUBNET", "E_SCHEMA_MISMATCH", "E_PORT_DIRECTION", "E_DATALINK_CONSUMES"];

Deno.test("registry: the machine walks bundle.candidates from orders:out and says what the registry said", () => {
  start();
  const cands = linkCandidates({ subnet: "orders", port: "out" }) as any[];
  const legalCands = cands.filter((c) => c.ok), refusedCands = cands.filter((c) => !c.ok);
  assert(legalCands.length > 0, "the default composition leaves orders:out some legal targets");
  assert(refusedCands.length > 0);
  const targets = portTargets(cands, { label: (key: string) => key });
  const { state, announce } = begin({ noun: "port", originKey: "port:orders:out", originLabel: "orders:out", targets });
  assertEquals(state.legal, legalCands.map((c) => c.key));
  assertEquals(state.refused, refusedCands.map((c) => c.key));
  assertStringIncludes(announce, `${legalCands.length} legal ports lit, ${refusedCands.length} refused`);

  // The first lit target: its announcement carries the rules the registry says it passed.
  let r = press(state, k("Tab"));
  const first = legalCands[0];
  assertEquals(r.effects, [{ type: "focus", key: first.key }]);
  assertStringIncludes(r.announce, first.verdict.passed[0].text);
  assertStringIncludes(r.announce, `${first.link.kind} link`);
  assertEquals(portLegalReason(first), first.verdict.passed.map((p: any) => p.text).join("; "));

  // Walk every refused target with R: each announcement is the registry's refusal, and at least
  // two distinct registry error codes are heard.
  const heard = new Set<string>();
  let s = state;
  for (const c of refusedCands) {
    r = press(s, k("r"));
    s = r.state;
    assertEquals(r.effects, [{ type: "focus", key: c.key }]);
    assertStringIncludes(r.announce, portRefusal(c));
    for (const code of REGISTRY_CODES) if (r.announce.includes(code)) heard.add(code);
  }
  assert(heard.size >= 2, `heard ${[...heard]}`);
  for (const code of ["PAGE_SAME_SUBNET", "E_SCHEMA_MISMATCH"]) assert(heard.has(code), `${code} is among the refusals from orders:out`);

  // Enter on a refused target links nothing.
  r = press(s, k("Enter"));
  assertEquals(r.effects, []);
  assertStringIncludes(r.announce, "Cannot link to");
});

Deno.test("registry: a commit from the machine is a link the registry accepts", () => {
  start();
  const cands = linkCandidates({ subnet: "orders", port: "out" }) as any[];
  const targets = portTargets(cands);
  let s = begin({ originKey: "port:orders:out", originLabel: "orders:out", targets }).state;
  s = press(s, k("Tab")).state;
  const r = press(s, k("Enter"));
  const commit = r.effects.find((e: any) => e.type === "commit") as any;
  assert(commit, "Enter on a lit target commits");
  const v = cands.find((c) => c.key === commit.key);
  assert(v && v.ok);
  const res = actions.addLink(v.link);
  assert(res.ok, "the registry accepts what the machine committed");
});

Deno.test("registry: the machine walks plan.slot_candidates for a piece", () => {
  start();
  const pieces = ["threats", "beam", "tt_best", "null_window"];
  let sawLegal = false, sawRefused = false;
  for (const name of pieces) {
    const cands = slotCandidates(name) as any[];
    const targets = slotTargets(cands, { label: (id: string) => `${id} slot` });
    const { state } = begin({ noun: "slot", originKey: `piece:${name}`, originLabel: name, targets });
    assertEquals(state.legal, cands.filter((c) => c.ok).map((c) => c.slot));
    for (const c of cands.filter((c) => c.ok)) {
      sawLegal = true;
      assertStringIncludes(targetText({ ...state, at: c.slot }, c.slot), slotLegalReason(c));
    }
    for (const c of cands.filter((c) => !c.ok)) {
      sawRefused = true;
      assertStringIncludes(targetText({ ...state, at: c.slot }, c.slot), c.why); // pflow-rs's own message
      assertStringIncludes(targetText(state, c.slot), slotRefusal(c));
    }
  }
  assert(sawLegal && sawRefused);
});

Deno.test("registry: targets the view does not draw are left out, as the pointer count leaves them out", () => {
  start();
  const cands = linkCandidates({ subnet: "orders", port: "out" }) as any[];
  const drawn = new Set(["workers:available", "payment:commit"]);
  const targets = portTargets(cands, { has: (key: string) => drawn.has(key) });
  assertEquals(targets.map((t: any) => t.key).sort(), [...drawn].sort());
});

// --- the texts ACCESSIBILITY.md quotes ----------------------------------------------------------------

Deno.test("ACCESSIBILITY.md quotes what the page says: its samples are built from the machine, so they cannot drift", async () => {
  start();
  // the spoken name of a port, as snap.js builds it from the composition's own subnets
  const name = (key: string) => {
    const [sn, ...rest] = key.split(":");
    const s = (subnetsById() as any)[sn];
    return portLabel(sn, s.ports.find((q: any) => q.id === rest.join(":")));
  };
  const cands = linkCandidates({ subnet: "orders", port: "out" }) as any[];
  const targets = portTargets(cands, { label: name });
  const b = begin({ noun: "port", originKey: "port:orders:out", originLabel: name("orders:out"), targets });
  const lit = press(b.state, k("Tab")).announce;
  const refused = press(b.state, k("r")).announce;
  const pinned = reduceInspector(initialInspector(), { type: "activate", id: "x", title: "port orders:in" });
  const samples: Array<[string, string]> = [
    ["entering link mode", b.announce],
    ["a lit target", lit],
    ["a refused target (R)", refused],
    ["Escape in link mode", press(b.state, k("Escape")).announce],
    ["a view that draws no target", noTargetsText("slot", "threats, order piece")],
    ["a number key in link mode", VIEW_KEYS_OFF],
    ["the inspector pinned", pinned.announce],
    ["the inspector dismissed", reduceInspector(pinned.state, { type: "escape" }).announce],
    ["the pin released by a redraw", reduceInspector(pinned.state, { type: "gone" }).announce],
    ["the registry did not load", registryFailureText(new Error("Failed to fetch\n  at fetch (x.js:1:1)"))],
    ["a view that did not load", brokenViewText({ id: "lens", short: "Lenses", broken: "TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:8080/compose/views/lens.js" })],
  ];
  const doc = await Deno.readTextFile(new URL("./ACCESSIBILITY.md", import.meta.url));
  const stale = samples.filter(([, text]) => !doc.includes(`"${text}"`));
  assertEquals(stale.map(([what, text]) => `${what}: "${text}"`), [], "ACCESSIBILITY.md quotes these differently: paste the text above (between the quotes) into the document");
  // and the refusal quoted is the registry's, not an invented code: it names PAGE_SAME_SUBNET and E_SCHEMA_MISMATCH only where they are said
  assertStringIncludes(refused, "PAGE_SAME_SUBNET");
  assert(!refused.includes("E_SCHEMA_MISMATCH"), "from orders:out the first refused port (orders:in) is refused for being on the same subnet");
});

// --- a redraw nobody asked for waits for the gesture -------------------------------------------------

Deno.test("afterGesture: with no gesture on, it runs at once", () => {
  let n = 0;
  afterGesture(() => false, () => n++, () => { throw new Error("no timer needed"); });
  assertEquals(n, 1);
});

Deno.test("afterGesture: with a gesture on, it waits, polling, and runs once when the gesture has ended", () => {
  let on = true, n = 0;
  const timers: Array<() => void> = [];
  afterGesture(() => on, () => n++, (f: () => void) => timers.push(f));
  assertEquals([n, timers.length], [0, 1]);
  timers.shift()!(); // still on: asks again
  assertEquals([n, timers.length], [0, 1]);
  on = false;
  timers.shift()!();
  assertEquals([n, timers.length], [1, 0], "ran, and stopped polling");
});
