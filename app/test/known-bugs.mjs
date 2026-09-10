import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectItems } from "../list.mjs";
import { remainingCount } from "../public/summary.mjs";

const { items } = JSON.parse(readFileSync(new URL("../seed.json", import.meta.url), "utf8"));

test("B01: search ignores case and surrounding whitespace", () => {
  for (const query of ["milk", "MILK", " Milk "]) {
    assert.deepEqual(selectItems(items, query).map((item) => item.name), ["Milk"]);
  }
});

test("B02: quantity sort is numeric", () => {
  assert.deepEqual(selectItems(items, "", "quantity").map((item) => item.quantity), [1, 1, 2, 3, 10, 12]);
});

test("B03: remaining count excludes bought items", () => {
  assert.equal(remainingCount({ total: 6, bought: 2 }), 4);
  assert.equal(remainingCount({ total: 6, bought: 3 }), 3);
  assert.equal(remainingCount({ total: 6, bought: 6 }), 0);
});
