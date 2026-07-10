import { test } from "node:test";
import assert from "node:assert/strict";
import { findTaxInclusivityMismatches } from "./find-tax-inclusivity-mismatches.js";

const REGION_PREF_TRUE = { attribute: "region_id", value: "reg_1", is_tax_inclusive: true };
const CURRENCY_PREF_FALSE = { attribute: "currency_code", value: "eur", is_tax_inclusive: false };

const context = (over = {}) => ({
  source_type: "shipping_option",
  source_id: "so_1",
  region_id: "reg_1",
  currency_code: "eur",
  ...over,
});

test("no mismatch when region and currency prefs agree", () => {
  const agreePref = { attribute: "currency_code", value: "eur", is_tax_inclusive: true };
  const findings = findTaxInclusivityMismatches([REGION_PREF_TRUE, agreePref], [context()]);
  assert.deepEqual(findings, []);
});

test("conflict when region and currency prefs disagree", () => {
  const findings = findTaxInclusivityMismatches([REGION_PREF_TRUE, CURRENCY_PREF_FALSE], [context()]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "region/currency preference conflict");
  assert.equal(findings[0].region_pref, true);
  assert.equal(findings[0].currency_pref, false);
});

test("no preference configured at all", () => {
  const findings = findTaxInclusivityMismatches([], [context({ region_id: "reg_unknown", currency_code: "jpy" })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, "no preference configured, defaults may drift");
  assert.equal(findings[0].region_pref, undefined);
  assert.equal(findings[0].currency_pref, undefined);
});

test("no mismatch when only one preference exists and no conflict possible", () => {
  const findings = findTaxInclusivityMismatches([REGION_PREF_TRUE], [context({ currency_code: "usd" })]);
  assert.deepEqual(findings, []);
});

test("source type and id are preserved on the finding", () => {
  const findings = findTaxInclusivityMismatches(
    [REGION_PREF_TRUE, CURRENCY_PREF_FALSE],
    [context({ source_type: "price_list", source_id: "plist_9" })]
  );
  assert.equal(findings[0].source_type, "price_list");
  assert.equal(findings[0].source_id, "plist_9");
});

test("multiple contexts only flags the mismatched one", () => {
  const okPref = { attribute: "region_id", value: "reg_ok", is_tax_inclusive: true };
  const okCtx = context({ source_id: "so_ok", region_id: "reg_ok", currency_code: "usd" });
  const badCtx = context({ source_id: "so_bad" });
  const findings = findTaxInclusivityMismatches([REGION_PREF_TRUE, CURRENCY_PREF_FALSE, okPref], [okCtx, badCtx]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].source_id, "so_bad");
});
