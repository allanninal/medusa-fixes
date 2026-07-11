import { test } from "node:test";
import assert from "node:assert/strict";
import { decideInventoryRepair } from "./repair-import-inventory.js";

const csvRow = (qty = 200, sku = "SKU-1") => ({ sku, variantInventoryQuantity: qty });
const variant = (inventoryItemId = "iitem_1", sku = "SKU-1") => ({ id: "variant_1", sku, inventoryItemId });
const level = (locationId = "sloc_default", stockedQuantity = 0) => ({ location_id: locationId, stocked_quantity: stockedQuantity });

test("CSV had no quantity does nothing", () => {
  assert.equal(decideInventoryRepair(csvRow(0), variant(), [], "sloc_default"), null);
});

test("CSV had negative quantity does nothing", () => {
  assert.equal(decideInventoryRepair(csvRow(-5), variant(), [], "sloc_default"), null);
});

test("no inventory item does nothing", () => {
  const result = decideInventoryRepair(csvRow(), variant(null), [], "sloc_default");
  assert.equal(result, null);
});

test("empty location levels creates a level", () => {
  const result = decideInventoryRepair(csvRow(), variant(), [], "sloc_default");
  assert.deepEqual(result, {
    action: "create_level",
    inventoryItemId: "iitem_1",
    locationId: "sloc_default",
    fromQty: 0,
    toQty: 200,
  });
});

test("level at zero updates to CSV quantity", () => {
  const result = decideInventoryRepair(csvRow(), variant(), [level("sloc_default", 0)], "sloc_default");
  assert.deepEqual(result, {
    action: "update_level",
    inventoryItemId: "iitem_1",
    locationId: "sloc_default",
    fromQty: 0,
    toQty: 200,
  });
});

test("level already matching CSV does nothing", () => {
  const result = decideInventoryRepair(csvRow(), variant(), [level("sloc_default", 200)], "sloc_default");
  assert.equal(result, null);
});

test("level at a different location creates the default level", () => {
  const result = decideInventoryRepair(csvRow(), variant(), [level("sloc_other", 50)], "sloc_default");
  assert.equal(result.action, "create_level");
  assert.equal(result.toQty, 200);
});

test("level with a different nonzero quantity updates", () => {
  const result = decideInventoryRepair(csvRow(75), variant(), [level("sloc_default", 10)], "sloc_default");
  assert.deepEqual(result, {
    action: "update_level",
    inventoryItemId: "iitem_1",
    locationId: "sloc_default",
    fromQty: 10,
    toQty: 75,
  });
});
