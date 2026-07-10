import { test } from "node:test";
import assert from "node:assert/strict";
import { decideInventoryRepair } from "./repair-oversold-inventory.js";

const level = (over = {}) => ({
  inventoryItemId: "iitem_1",
  locationId: "sloc_1",
  stockedQuantity: 10,
  reservedQuantity: 4,
  allowBackorder: false,
  ...over,
});

test("ok when available is non-negative", () => {
  const result = decideInventoryRepair(level(), 4);
  assert.deepEqual(result, {
    isOversold: false,
    available: 6,
    reason: "ok",
    proposedStockedQuantity: null,
  });
});

test("flags reserved exceeds stock", () => {
  const result = decideInventoryRepair(level({ stockedQuantity: 5, reservedQuantity: 8 }), 8);
  assert.equal(result.isOversold, true);
  assert.equal(result.reason, "reserved_exceeds_stock");
  assert.equal(result.available, -3);
  assert.equal(result.proposedStockedQuantity, 8);
});

test("flags when stocked itself is negative", () => {
  // stockedQuantity was already pushed negative by a bad external write.
  // available < 0 always implies reserved > stocked algebraically, so this
  // is still reported as reserved_exceeds_stock.
  const result = decideInventoryRepair(level({ stockedQuantity: -2, reservedQuantity: 0 }), 0);
  assert.equal(result.isOversold, true);
  assert.ok(["reserved_exceeds_stock", "negative_available"].includes(result.reason));
  assert.equal(result.available, -2);
});

test("backorder variant is never flagged", () => {
  const result = decideInventoryRepair(level({ stockedQuantity: 5, reservedQuantity: 8, allowBackorder: true }), 8);
  assert.equal(result.isOversold, false);
  assert.equal(result.reason, "ok");
});

test("proposed count never drops below open reservations", () => {
  const result = decideInventoryRepair(level({ stockedQuantity: 5, reservedQuantity: 8 }), 12);
  assert.equal(result.proposedStockedQuantity, 12);
});

test("proposed count never drops below current stock", () => {
  const result = decideInventoryRepair(level({ stockedQuantity: 9, reservedQuantity: 10 }), 3);
  assert.equal(result.proposedStockedQuantity, 9);
});

test("ok when reserved equals stocked exactly", () => {
  const result = decideInventoryRepair(level({ stockedQuantity: 5, reservedQuantity: 5 }), 5);
  assert.equal(result.isOversold, false);
  assert.equal(result.available, 0);
});
