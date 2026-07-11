import { test } from "node:test";
import assert from "node:assert/strict";
import { isCancelBlockedByNegativeStock, fulfillmentInventoryRefs } from "./find-blocked-cancels.js";

const fulfillment = (over = {}) => ({ id: "ful_1", canceled_at: null, ...over });
const level = (over = {}) => ({ stocked_quantity: 5, reserved_quantity: 3, ...over });

test("blocked when available is negative", () => {
  const lvl = level({ stocked_quantity: 2, reserved_quantity: 5 });
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), lvl), true);
});

test("not blocked when available is zero", () => {
  const lvl = level({ stocked_quantity: 5, reserved_quantity: 5 });
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), lvl), false);
});

test("not blocked when available is positive", () => {
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), level()), false);
});

test("not blocked when already canceled", () => {
  const lvl = level({ stocked_quantity: 1, reserved_quantity: 9 });
  assert.equal(isCancelBlockedByNegativeStock(fulfillment({ canceled_at: "2026-07-01T00:00:00Z" }), lvl), false);
});

test("not blocked when no location level", () => {
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), null), false);
});

test("not blocked when quantities missing", () => {
  const lvl = level({ stocked_quantity: null, reserved_quantity: null });
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), lvl), false);
});

test("blocked exactly one unit short", () => {
  const lvl = level({ stocked_quantity: 4, reserved_quantity: 5 });
  assert.equal(isCancelBlockedByNegativeStock(fulfillment(), lvl), true);
});

test("fulfillmentInventoryRefs pairs each item with the fulfillment location", () => {
  const f = fulfillment({
    location_id: "sloc_1",
    items: [{ inventory_item_id: "iitem_1" }, { inventory_item_id: "iitem_2" }],
  });
  assert.deepEqual(fulfillmentInventoryRefs(f), [
    ["iitem_1", "sloc_1"],
    ["iitem_2", "sloc_1"],
  ]);
});

test("fulfillmentInventoryRefs skips items with no inventory_item_id", () => {
  const f = fulfillment({ location_id: "sloc_1", items: [{ inventory_item_id: null }] });
  assert.deepEqual(fulfillmentInventoryRefs(f), []);
});
