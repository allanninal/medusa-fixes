import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveItemLocations, isAffectedCart } from "./detect-multi-location-cart.js";

const level = (locationId, stocked, reserved = 0) => ({
  locationId,
  stockedQuantity: stocked,
  reservedQuantity: reserved,
});

test("disjoint locations flags the cart", () => {
  const items = [
    { lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 1 },
    { lineItemId: "item_b", inventoryItemId: "iitem_b", requiredQty: 1 },
  ];
  const levels = {
    iitem_a: [level("sloc_east", 5)],
    iitem_b: [level("sloc_west", 5)],
  };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east", "sloc_west"]);
  assert.deepEqual(itemLocations, [
    { lineItemId: "item_a", validLocationIds: ["sloc_east"] },
    { lineItemId: "item_b", validLocationIds: ["sloc_west"] },
  ]);
  assert.equal(isAffectedCart(itemLocations), true);
});

test("shared location is not affected", () => {
  const items = [
    { lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 1 },
    { lineItemId: "item_b", inventoryItemId: "iitem_b", requiredQty: 1 },
  ];
  const levels = {
    iitem_a: [level("sloc_east", 5), level("sloc_west", 5)],
    iitem_b: [level("sloc_west", 5)],
  };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east", "sloc_west"]);
  assert.equal(isAffectedCart(itemLocations), false);
});

test("item with no valid location is a real stockout, not this bug", () => {
  const items = [
    { lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 10 },
    { lineItemId: "item_b", inventoryItemId: "iitem_b", requiredQty: 1 },
  ];
  const levels = {
    iitem_a: [level("sloc_east", 2)],
    iitem_b: [level("sloc_west", 5)],
  };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east", "sloc_west"]);
  assert.deepEqual(itemLocations[0].validLocationIds, []);
  assert.equal(isAffectedCart(itemLocations), false);
});

test("locations outside the channel are excluded", () => {
  const items = [{ lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 1 }];
  const levels = { iitem_a: [level("sloc_unlinked", 100)] };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east"]);
  assert.deepEqual(itemLocations, [{ lineItemId: "item_a", validLocationIds: [] }]);
  assert.equal(isAffectedCart(itemLocations), false);
});

test("insufficient quantity at a location excludes it", () => {
  const items = [{ lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 5 }];
  const levels = { iitem_a: [level("sloc_east", 4)] };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east"]);
  assert.deepEqual(itemLocations[0].validLocationIds, []);
});

test("empty cart is not affected", () => {
  assert.equal(isAffectedCart([]), false);
});

test("reserved quantity reduces available stock", () => {
  const items = [{ lineItemId: "item_a", inventoryItemId: "iitem_a", requiredQty: 3 }];
  const levels = { iitem_a: [level("sloc_east", 5, 3)] };
  const itemLocations = resolveItemLocations(items, levels, ["sloc_east"]);
  assert.deepEqual(itemLocations[0].validLocationIds, []);
});
