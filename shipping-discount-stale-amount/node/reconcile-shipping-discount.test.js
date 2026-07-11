import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeExpectedShippingAdjustment,
  evaluateStaleAdjustment,
} from "./reconcile-shipping-discount.js";

const shippingMethod = (over = {}) => ({ id: "sm_1", amount: 1079, ...over });

const promotion = (over = {}) => ({
  id: "promo_1",
  code: "FREESHIP",
  application_method: { type: "percentage", value: 100, target_type: "shipping_methods" },
  ...over,
});

test("percentage full off matches current amount", () => {
  const result = computeExpectedShippingAdjustment(shippingMethod(), promotion());
  assert.equal(result.adjustment_amount, 1079);
});

test("percentage partial off", () => {
  const promo = promotion({ application_method: { type: "percentage", value: 50, target_type: "shipping_methods" } });
  const result = computeExpectedShippingAdjustment(shippingMethod(), promo);
  assert.equal(result.adjustment_amount, 539.5);
});

test("fixed amount capped at shipping amount", () => {
  const promo = promotion({ application_method: { type: "fixed", value: 5000, target_type: "shipping_methods" } });
  const result = computeExpectedShippingAdjustment(shippingMethod({ amount: 1079 }), promo);
  assert.equal(result.adjustment_amount, 1079);
});

test("fixed amount below shipping amount", () => {
  const promo = promotion({ application_method: { type: "fixed", value: 300, target_type: "shipping_methods" } });
  const result = computeExpectedShippingAdjustment(shippingMethod({ amount: 1079 }), promo);
  assert.equal(result.adjustment_amount, 300);
});

test("non shipping target returns null", () => {
  const promo = promotion({ application_method: { type: "percentage", value: 100, target_type: "items" } });
  assert.equal(computeExpectedShippingAdjustment(shippingMethod(), promo), null);
});

test("stale when stored amount is from before refresh", () => {
  const result = evaluateStaleAdjustment(shippingMethod(), promotion(), 929);
  assert.equal(result.is_stale, true);
  assert.equal(result.delta, 929 - 1079);
});

test("not stale when stored matches expected", () => {
  const result = evaluateStaleAdjustment(shippingMethod(), promotion(), 1079);
  assert.equal(result.is_stale, false);
  assert.equal(result.delta, 0);
});

test("not stale within tolerance", () => {
  const result = evaluateStaleAdjustment(shippingMethod(), promotion(), 1079.005);
  assert.equal(result.is_stale, false);
});

test("null when promotion not shipping targeted", () => {
  const promo = promotion({ application_method: { type: "percentage", value: 100, target_type: "items" } });
  assert.equal(evaluateStaleAdjustment(shippingMethod(), promo, 929), null);
});
