import { test } from "node:test";
import assert from "node:assert/strict";
import { findCurrencyMismatches } from "./find-currency-mismatches.js";

const REGION = { id: "reg_in", currency_code: "inr" };

const variantPrice = (over = {}) => ({
  variant_id: "variant_1",
  product_id: "prod_1",
  prices: [{ id: "price_1", currency_code: "inr", amount: 1499.0, price_list_id: null }],
  calculated_price: { currency_code: "inr", price_list_id: null },
  ...over,
});

test("no finding when currencies match", () => {
  assert.deepEqual(findCurrencyMismatches(REGION, [variantPrice()]), []);
});

test("calculated mismatch when resolved currency differs", () => {
  const vp = variantPrice({ calculated_price: { currency_code: "eur", price_list_id: "plist_1" } });
  const findings = findCurrencyMismatches(REGION, [vp]);
  assert.deepEqual(findings, [{
    product_id: "prod_1",
    variant_id: "variant_1",
    region_id: "reg_in",
    expected_currency: "inr",
    shown_currency: "eur",
    price_id: undefined,
    price_list_id: "plist_1",
    reason: "calculated_mismatch",
  }]);
});

test("missing currency row when no row matches region", () => {
  const vp = variantPrice({
    calculated_price: null,
    prices: [{ id: "price_2", currency_code: "eur", amount: 42.0, price_list_id: null }],
  });
  const findings = findCurrencyMismatches(REGION, [vp]);
  assert.deepEqual(findings, [{
    product_id: "prod_1",
    variant_id: "variant_1",
    region_id: "reg_in",
    expected_currency: "inr",
    shown_currency: "eur",
    price_id: "price_2",
    price_list_id: null,
    reason: "missing_currency_row",
  }]);
});

test("missing currency row with no prices at all", () => {
  const vp = variantPrice({ calculated_price: null, prices: [] });
  const findings = findCurrencyMismatches(REGION, [vp]);
  assert.equal(findings[0].reason, "missing_currency_row");
  assert.equal(findings[0].shown_currency, undefined);
  assert.equal(findings[0].price_id, undefined);
});

test("calculated mismatch takes priority over row check", () => {
  const vp = variantPrice({
    calculated_price: { currency_code: "usd", price_list_id: null },
    prices: [{ id: "price_3", currency_code: "inr", amount: 1499.0, price_list_id: null }],
  });
  const findings = findCurrencyMismatches(REGION, [vp]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "calculated_mismatch");
});

test("multiple variants only flags the mismatched one", () => {
  const okVp = variantPrice({ variant_id: "variant_ok" });
  const badVp = variantPrice({ variant_id: "variant_bad", calculated_price: { currency_code: "eur", price_list_id: null } });
  const findings = findCurrencyMismatches(REGION, [okVp, badVp]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].variant_id, "variant_bad");
});

test("no currency row and no calculated price still flags missing row", () => {
  const vp = variantPrice({
    calculated_price: null,
    prices: [{ id: "price_4", currency_code: "usd", amount: 10.0, price_list_id: "plist_2" }],
  });
  const findings = findCurrencyMismatches(REGION, [vp]);
  assert.equal(findings[0].reason, "missing_currency_row");
  assert.equal(findings[0].price_list_id, "plist_2");
});
