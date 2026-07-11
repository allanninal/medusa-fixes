import { test } from "node:test";
import assert from "node:assert/strict";
import { detectUntrackedQuantityDrift } from "./detect-untracked-drift.js";

const variant = (over = {}) => ({
  variantId: "variant_1",
  manageInventory: false,
  inventoryItemId: "iitem_1",
  locationLevels: [{ locationId: "sloc_1", stockedQuantity: 8 }],
  ...over,
});

const baselineOf = (qty, itemId = "iitem_1", locationId = "sloc_1") =>
  new Map([[itemId, new Map([[locationId, qty]])]]);

test("no drift when quantity unchanged", () => {
  const result = detectUntrackedQuantityDrift([variant()], baselineOf(8));
  assert.deepEqual(result, []);
});

test("flags drop in stocked quantity", () => {
  const result = detectUntrackedQuantityDrift([variant()], baselineOf(10));
  assert.equal(result.length, 1);
  const [record] = result;
  assert.equal(record.variantId, "variant_1");
  assert.equal(record.inventoryItemId, "iitem_1");
  assert.equal(record.locationId, "sloc_1");
  assert.equal(record.baselineQuantity, 10);
  assert.equal(record.currentQuantity, 8);
  assert.equal(record.delta, -2);
});

test("flags increase too since any change is suspect", () => {
  const result = detectUntrackedQuantityDrift([variant()], baselineOf(5));
  assert.equal(result.length, 1);
  assert.equal(result[0].delta, 3);
});

test("skips tracked variants", () => {
  const result = detectUntrackedQuantityDrift([variant({ manageInventory: true })], baselineOf(999));
  assert.deepEqual(result, []);
});

test("skips variant with no inventory item", () => {
  const result = detectUntrackedQuantityDrift([variant({ inventoryItemId: null })], baselineOf(999));
  assert.deepEqual(result, []);
});

test("skips variant with no location levels", () => {
  const result = detectUntrackedQuantityDrift([variant({ locationLevels: [] })], baselineOf(999));
  assert.deepEqual(result, []);
});

test("skips location missing from baseline", () => {
  const baseline = new Map([["iitem_1", new Map()]]);
  const result = detectUntrackedQuantityDrift([variant()], baseline);
  assert.deepEqual(result, []);
});

test("skips inventory item missing from baseline entirely", () => {
  const result = detectUntrackedQuantityDrift([variant()], new Map());
  assert.deepEqual(result, []);
});

test("multiple locations only flags the changed one", () => {
  const v = variant({
    locationLevels: [
      { locationId: "sloc_1", stockedQuantity: 8 },
      { locationId: "sloc_2", stockedQuantity: 4 },
    ],
  });
  const baseline = new Map([["iitem_1", new Map([["sloc_1", 10], ["sloc_2", 4]])]]);
  const result = detectUntrackedQuantityDrift([v], baseline);
  assert.equal(result.length, 1);
  assert.equal(result[0].locationId, "sloc_1");
});
