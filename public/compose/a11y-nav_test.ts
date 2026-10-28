// Arrow-key movement among drawn things, and the roving Tab stop.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clicksItself, hasNativeRole, isTypingTarget, keepsOwnName, moveSpatial, roleFor, rovingTarget, tabStop, tabTarget } from "./a11y-nav.js";

// A 3 x 2 grid, row-major: indices 0 1 2 / 3 4 5.
const grid = [0, 1, 2, 3, 4, 5].map((i) => ({ x: (i % 3) * 50, y: Math.floor(i / 3) * 40 }));

Deno.test("moveSpatial: each arrow goes to the neighbour in that direction", () => {
  assertEquals(moveSpatial(grid, 1, "ArrowRight"), 2);
  assertEquals(moveSpatial(grid, 1, "ArrowLeft"), 0);
  assertEquals(moveSpatial(grid, 1, "ArrowDown"), 4);
  assertEquals(moveSpatial(grid, 4, "ArrowUp"), 1);
  assertEquals(moveSpatial(grid, 2, "ArrowRight"), -1, "nothing further right");
  assertEquals(moveSpatial(grid, 0, "ArrowUp"), -1);
  assertEquals(moveSpatial(grid, 0, "x"), -1);
});

Deno.test("moveSpatial: straight ahead beats nearer but off to the side", () => {
  const items = [{ x: 0, y: 0 }, { x: 30, y: 60 }, { x: 100, y: 0 }];
  assertEquals(moveSpatial(items, 0, "ArrowRight"), 2); // (30,60) is nearer in x but far off the row
  assertEquals(moveSpatial(items, 0, "ArrowDown"), 1);
});

Deno.test("moveSpatial: an item at the same place (a box and the thing it contains) is not 'ahead'", () => {
  const items = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 80, y: 10 }];
  assertEquals(moveSpatial(items, 0, "ArrowRight"), 2);
  assertEquals(moveSpatial(items, 0, "ArrowLeft"), -1);
});

Deno.test("rovingTarget: Home, End, and arrows from no position", () => {
  assertEquals(rovingTarget(grid, 3, "Home"), 0);
  assertEquals(rovingTarget(grid, 3, "End"), 5);
  assertEquals(rovingTarget(grid, -1, "ArrowRight"), 0);
  assertEquals(rovingTarget(grid, -1, "a"), -1);
  assertEquals(rovingTarget([], 0, "Home"), -1);
  assertEquals(rovingTarget(grid, 1, "ArrowDown"), 4);
});

Deno.test("tabTarget: arrows wrap, Home and End jump", () => {
  assertEquals(tabTarget(10, 9, "ArrowRight"), 0);
  assertEquals(tabTarget(10, 0, "ArrowLeft"), 9);
  assertEquals(tabTarget(10, 4, "Home"), 0);
  assertEquals(tabTarget(10, 4, "End"), 9);
  assertEquals(tabTarget(10, 4, "Enter"), -1);
  assertEquals(tabTarget(0, 0, "ArrowRight"), -1);
});

Deno.test("tabStop: the remembered key while it exists, else the first", () => {
  assertEquals(tabStop(["a", "b", "c"], "b"), 1);
  assertEquals(tabStop(["a", "b", "c"], "z"), 0);
  assertEquals(tabStop(["a"], null), 0);
  assertEquals(tabStop([], "a"), -1);
});

// --- how a thing is exposed -------------------------------------------------------------------------

Deno.test("roleFor: a native button, link or list item keeps its role; a role a view chose stays", () => {
  for (const tag of ["BUTTON", "A", "LI", "SUMMARY", "INPUT", "SELECT", "TEXTAREA", "button", "li"]) {
    assertEquals(roleFor({ tag, group: "item" }), null, tag);
  }
  assertEquals(roleFor({ tag: "div", hasRole: true, group: "item" }), null);
  assert(hasNativeRole("li") && hasNativeRole("A") && !hasNativeRole("div") && !hasNativeRole("g") && !hasNativeRole(undefined));
});

Deno.test("roleFor: never a button over other controls (nested-interactive); a group instead", () => {
  assertEquals(roleFor({ tag: "div", holdsControls: true, group: "item" }), "group"); // the Lenses card with a Go button
  assertEquals(roleFor({ tag: "g", svg: true, holdsControls: true, group: "item" }), "group"); // an order piece holding move/remove buttons
  assertEquals(roleFor({ tag: "g", svg: true, holdsControls: true, group: "port" }), "group");
});

Deno.test("roleFor: drawn leaves and small controls are buttons; readable HTML is a group", () => {
  assertEquals(roleFor({ tag: "g", svg: true, group: "port" }), "button");
  assertEquals(roleFor({ tag: "rect", svg: true, group: "item" }), "button");
  assertEquals(roleFor({ tag: "g", svg: true, group: "action" }), "button");
  assertEquals(roleFor({ tag: "span", group: "piece" }), "button"); // a palette piece
  assertEquals(roleFor({ tag: "div", group: "item" }), "group"); // HTML content stays readable
  assertEquals(roleFor({ tag: "div", group: "panel" }), "group"); // a rule row in the side column
});

Deno.test("keepsOwnName: a button or link with visible words keeps them; nothing else does", () => {
  assert(keepsOwnName({ tag: "BUTTON", text: "sync-spiders 12/12 proved" }));
  assert(keepsOwnName({ tag: "a", text: "docs" }));
  assert(!keepsOwnName({ tag: "BUTTON", text: "  " }), "an icon-only button needs a name");
  assert(!keepsOwnName({ tag: "BUTTON" }));
  assert(!keepsOwnName({ tag: "LI", text: "a long row" }), "a list item is not named by its content");
  assert(!keepsOwnName({ tag: "g", text: "x" }));
});

Deno.test("clicksItself: the browser clicks a button or link on Enter, so the page must not click it again", () => {
  assert(clicksItself("BUTTON") && clicksItself("a") && clicksItself("SUMMARY"));
  assert(!clicksItself("li") && !clicksItself("g") && !clicksItself("div"));
});

Deno.test("isTypingTarget: form fields, contenteditable and ARIA text boxes own the keys", () => {
  const n = (tag: string, o: Record<string, unknown> = {}) => ({ tag, editable: false, role: null, ...o });
  assert(isTypingTarget([n("INPUT")]));
  assert(isTypingTarget([n("textarea")]));
  assert(isTypingTarget([n("SELECT")]), "a select is not for number keys");
  assert(isTypingTarget([n("DIV", { editable: true })]), "contenteditable");
  assert(isTypingTarget([n("DIV", { role: "textbox" })]));
  assert(isTypingTarget([n("DIV", { role: "combobox" })]));
  assert(isTypingTarget([n("SPAN"), n("DIV", { editable: true })]), "a child of an editable region");
  assert(!isTypingTarget([n("BODY")]));
  assert(!isTypingTarget([n("g"), n("svg"), n("DIV", { role: "tabpanel" }), n("BODY")]));
  assert(!isTypingTarget([]) && !isTypingTarget(undefined) && !isTypingTarget([null]));
});
