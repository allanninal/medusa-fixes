import { test } from "node:test";
import assert from "node:assert/strict";
import { isDefaultPriceWronglySuppressed, rulesMatch } from "./find-suppressed-default-price.js";

test("not suppressed when not from price list", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 1000,
    isCalculatedPriceFromPriceList: false,
    priceListRules: {},
    requestContext: { customerGroupIds: [] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, "none");
});

test("not suppressed when no default to compare", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 1000,
    isCalculatedPriceFromPriceList: true,
    priceListRules: {},
    requestContext: { customerGroupIds: [] },
    defaultAmountForCurrency: null,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, "none");
});

test("suppressed when rules do not match context", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 900,
    isCalculatedPriceFromPriceList: true,
    priceListRules: { customer_group_id: ["cusgrp_vip"] },
    requestContext: { customerGroupIds: ["cusgrp_general"] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, "rules_mismatch");
});

test("suppressed when price list amount higher than default", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 1500,
    isCalculatedPriceFromPriceList: true,
    priceListRules: {},
    requestContext: { customerGroupIds: [] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, "higher_than_default");
});

test("not suppressed when rules match and price is lower", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 900,
    isCalculatedPriceFromPriceList: true,
    priceListRules: { customer_group_id: ["cusgrp_vip"] },
    requestContext: { customerGroupIds: ["cusgrp_vip"] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, "none");
});

test("not suppressed when price list amount equal to default", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 1200,
    isCalculatedPriceFromPriceList: true,
    priceListRules: {},
    requestContext: { customerGroupIds: [] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, false);
  assert.equal(result.reason, "none");
});

test("rules mismatch takes priority over amount comparison", () => {
  const result = isDefaultPriceWronglySuppressed({
    calculatedAmount: 500,
    isCalculatedPriceFromPriceList: true,
    priceListRules: { customer_group_id: ["cusgrp_vip"] },
    requestContext: { customerGroupIds: ["cusgrp_general"] },
    defaultAmountForCurrency: 1200,
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, "rules_mismatch");
});

test("rulesMatch with no rules is always true", () => {
  assert.equal(rulesMatch({}, { customerGroupIds: [] }), true);
});

test("rulesMatch detects intersection", () => {
  assert.equal(rulesMatch({ customer_group_id: ["a", "b"] }, { customerGroupIds: ["b"] }), true);
  assert.equal(rulesMatch({ customer_group_id: ["a", "b"] }, { customerGroupIds: ["c"] }), false);
});

test("rulesMatch ignores unknown rule keys", () => {
  assert.equal(rulesMatch({ region_id: ["reg_1"] }, { customerGroupIds: [] }), true);
});
