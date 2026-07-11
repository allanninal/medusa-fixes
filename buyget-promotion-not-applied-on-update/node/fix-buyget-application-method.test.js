import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBuygetApplicationMethodValid,
  buildCorrectedApplicationMethod,
} from "./fix-buyget-application-method.js";

const validAm = (over = {}) => ({
  id: "apmethod_1",
  target_type: "items",
  allocation: "across",
  apply_to_quantity: 1,
  max_quantity: null,
  buy_rules: [{ attribute: "items.product_id", operator: "in", values: ["prod_1"] }],
  target_rules: [{ attribute: "items.product_id", operator: "in", values: ["prod_2"] }],
  buy_rules_min_quantity: 2,
  ...over,
});

test("valid across payload passes", () => {
  const result = isBuygetApplicationMethodValid(validAm());
  assert.deepEqual(result, { valid: true, reasons: [] });
});

test("valid each payload with max_quantity passes", () => {
  const am = validAm({ allocation: "each", max_quantity: 1 });
  assert.equal(isBuygetApplicationMethodValid(am).valid, true);
});

test("each without max_quantity is invalid", () => {
  const am = validAm({ allocation: "each", max_quantity: null });
  const result = isBuygetApplicationMethodValid(am);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("max_quantity is required when allocation is each"));
});

test("target_type order is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ target_type: "order" }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((r) => r.includes("target_type")));
});

test("empty target_rules is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ target_rules: [] }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("target_rules is empty"));
});

test("missing target_rules key is invalid", () => {
  const am = validAm();
  delete am.target_rules;
  const result = isBuygetApplicationMethodValid(am);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("target_rules is empty"));
});

test("empty buy_rules is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ buy_rules: [] }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("buy_rules is empty"));
});

test("missing buy_rules_min_quantity is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ buy_rules_min_quantity: null }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("buy_rules_min_quantity is missing or not positive"));
});

test("zero buy_rules_min_quantity is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ buy_rules_min_quantity: 0 }));
  assert.equal(result.valid, false);
});

test("negative buy_rules_min_quantity is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ buy_rules_min_quantity: -1 }));
  assert.equal(result.valid, false);
});

test("bad allocation is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ allocation: "whole_order" }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("allocation must be across or each"));
});

test("missing apply_to_quantity is invalid", () => {
  const result = isBuygetApplicationMethodValid(validAm({ apply_to_quantity: null }));
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("apply_to_quantity is missing"));
});

test("multiple reasons can be reported together", () => {
  const result = isBuygetApplicationMethodValid(
    validAm({ target_type: "order", target_rules: [], buy_rules: [] })
  );
  assert.equal(result.valid, false);
  assert.equal(result.reasons.length, 3);
});

test("buildCorrectedApplicationMethod fixes target_type", () => {
  const am = validAm({ target_type: "order" });
  const corrected = buildCorrectedApplicationMethod(am);
  assert.equal(corrected.target_type, "items");
  assert.equal(corrected.id, "apmethod_1");
  assert.deepEqual(corrected.buy_rules, am.buy_rules);
  assert.deepEqual(corrected.target_rules, am.target_rules);
  assert.equal("max_quantity" in corrected, false);
});

test("buildCorrectedApplicationMethod fills max_quantity for each", () => {
  const am = validAm({ allocation: "each", max_quantity: null, apply_to_quantity: 3 });
  const corrected = buildCorrectedApplicationMethod(am);
  assert.equal(corrected.allocation, "each");
  assert.equal(corrected.max_quantity, 3);
});

test("buildCorrectedApplicationMethod defaults bad allocation to across", () => {
  const am = validAm({ allocation: "whole_order" });
  const corrected = buildCorrectedApplicationMethod(am);
  assert.equal(corrected.allocation, "across");
});

test("buildCorrectedApplicationMethod falls back apply_to_quantity", () => {
  const am = validAm({ apply_to_quantity: null, buy_rules_min_quantity: 2 });
  const corrected = buildCorrectedApplicationMethod(am);
  assert.equal(corrected.apply_to_quantity, 2);
});
