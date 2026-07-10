import { test } from "node:test";
import assert from "node:assert/strict";
import { decideInventoryRepair } from "./create-missing-levels.js";

const variant = (over = {}) => ({ manageInventory: true, inventoryItemId: "iitem_1", ...over });

test("untracked variant is skipped", () => {
  const result = decideInventoryRepair(variant({ manageInventory: false }), [], ["sloc_1"]);
  assert.deepEqual(result, { action: "skip", missingLocationIds: [] });
});

test("managed variant without inventory item is flagged", () => {
  const result = decideInventoryRepair(variant({ inventoryItemId: null }), [], ["sloc_1"]);
  assert.deepEqual(result, { action: "flag_no_inventory_item", missingLocationIds: [] });
});

test("managed variant with all required levels is ok", () => {
  const levels = [{ locationId: "sloc_1", stockedQuantity: 5 }];
  const result = decideInventoryRepair(variant(), levels, ["sloc_1"]);
  assert.deepEqual(result, { action: "ok", missingLocationIds: [] });
});

test("managed variant with no levels at all needs repair", () => {
  const result = decideInventoryRepair(variant(), [], ["sloc_1"]);
  assert.deepEqual(result, { action: "create_zero_level", missingLocationIds: ["sloc_1"] });
});

test("managed variant with level at wrong location needs repair", () => {
  const levels = [{ locationId: "sloc_wrong", stockedQuantity: 10 }];
  const result = decideInventoryRepair(variant(), levels, ["sloc_1"]);
  assert.deepEqual(result, { action: "create_zero_level", missingLocationIds: ["sloc_1"] });
});

test("only missing locations are returned when some exist", () => {
  const levels = [{ locationId: "sloc_1", stockedQuantity: 3 }];
  const result = decideInventoryRepair(variant(), levels, ["sloc_1", "sloc_2"]);
  assert.deepEqual(result, { action: "create_zero_level", missingLocationIds: ["sloc_2"] });
});

test("no required locations means ok", () => {
  const result = decideInventoryRepair(variant(), [], []);
  assert.deepEqual(result, { action: "ok", missingLocationIds: [] });
});

test("multiple missing locations are all returned", () => {
  const result = decideInventoryRepair(variant(), [], ["sloc_1", "sloc_2", "sloc_3"]);
  assert.deepEqual(result, { action: "create_zero_level", missingLocationIds: ["sloc_1", "sloc_2", "sloc_3"] });
});
