// Arrow-key movement among drawn things, and the roving Tab stop.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { moveSpatial, rovingTarget, tabStop, tabTarget } from "./a11y-nav.js";

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
