import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStalePriceListOverride } from "./detect-multi-group-price-mismatch.js";

const priceList = (over = {}) => ({
  id: "plist_1",
  rules: [{ attribute: "customer.groups.id", value: ["grp_1", "grp_2"] }],
  ...over,
});

test("flags multigroup customer that fell back to default", () => {
  const result = detectStalePriceListOverride(
    ["grp_1", "grp_9"],
    priceList(),
    { price_list_id: null, amount: 1000 },
    { price_list_id: "plist_1", amount: 800 }
  );
  assert.equal(result.isAffected, true);
  assert.equal(result.expectedPriceListId, "plist_1");
});

test("no mismatch when resolved price matches", () => {
  const result = detectStalePriceListOverride(
    ["grp_1", "grp_9"],
    priceList(),
    { price_list_id: "plist_1", amount: 800 },
    { price_list_id: "plist_1", amount: 800 }
  );
  assert.equal(result.isAffected, false);
});

test("no mismatch when group does not intersect rule", () => {
  const result = detectStalePriceListOverride(
    ["grp_9", "grp_10"],
    priceList(),
    { price_list_id: null, amount: 1000 },
    { price_list_id: null, amount: 1000 }
  );
  assert.equal(result.isAffected, false);
});

test("no mismatch when price list has no group rule", () => {
  const pl = priceList({ rules: [{ attribute: "region_id", value: ["reg_1"] }] });
  const result = detectStalePriceListOverride(
    ["grp_1"],
    pl,
    { price_list_id: null, amount: 1000 },
    { price_list_id: null, amount: 1000 }
  );
  assert.equal(result.isAffected, false);
});

test("no mismatch when customer has no groups", () => {
  const result = detectStalePriceListOverride(
    [],
    priceList(),
    { price_list_id: null, amount: 1000 },
    { price_list_id: null, amount: 1000 }
  );
  assert.equal(result.isAffected, false);
});

test("no mismatch when control also fell back", () => {
  const result = detectStalePriceListOverride(
    ["grp_1", "grp_2"],
    priceList(),
    { price_list_id: null, amount: 1000 },
    { price_list_id: null, amount: 1000 }
  );
  assert.equal(result.isAffected, false);
});

test("single group customer matching control is not flagged", () => {
  const result = detectStalePriceListOverride(
    ["grp_1"],
    priceList(),
    { price_list_id: "plist_1", amount: 800 },
    { price_list_id: "plist_1", amount: 800 }
  );
  assert.equal(result.isAffected, false);
});
