import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVariantInventoryRisk } from "./classify-inventory-risk.js";

const variant = (over = {}) => ({
  id: "variant_1",
  sku: "SKU-1",
  manage_inventory: true,
  inventory_items: [{ id: "iitem_1", inventory: { location_levels: [{ stocked_quantity: 5 }] } }],
  product_tags: [],
  ...over,
});

test("ok when managed and stocked", () => {
  assert.equal(classifyVariantInventoryRisk(variant()), "ok");
});

test("unmanaged risk when flag false", () => {
  assert.equal(classifyVariantInventoryRisk(variant({ manage_inventory: false })), "unmanaged_risk");
});

test("unmanaged risk when flag missing", () => {
  assert.equal(classifyVariantInventoryRisk(variant({ manage_inventory: null })), "unmanaged_risk");
});

test("managed but untracked when no inventory items", () => {
  assert.equal(classifyVariantInventoryRisk(variant({ inventory_items: [] })), "managed_but_untracked");
});

test("managed but untracked when no location levels have stock", () => {
  const v = variant({ inventory_items: [{ id: "iitem_1", inventory: { location_levels: [{ stocked_quantity: 0 }] } }] });
  assert.equal(classifyVariantInventoryRisk(v), "managed_but_untracked");
});

test("managed but untracked when inventory items have no inventory key", () => {
  const v = variant({ inventory_items: [{ id: "iitem_1" }] });
  assert.equal(classifyVariantInventoryRisk(v), "managed_but_untracked");
});

test("exempt wins even when unmanaged", () => {
  const v = variant({ manage_inventory: false, product_tags: ["digital"] });
  assert.equal(classifyVariantInventoryRisk(v), "exempt");
});

test("exempt with custom tag list", () => {
  const v = variant({ manage_inventory: false, product_tags: ["subscription"] });
  assert.equal(classifyVariantInventoryRisk(v, ["subscription"]), "exempt");
});

test("ok when multiple location levels and one has stock", () => {
  const v = variant({
    inventory_items: [{
      id: "iitem_1",
      inventory: { location_levels: [{ stocked_quantity: 0 }, { stocked_quantity: 3 }] },
    }],
  });
  assert.equal(classifyVariantInventoryRisk(v), "ok");
});
