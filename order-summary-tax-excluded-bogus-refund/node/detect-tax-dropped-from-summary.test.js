import { test } from "node:test";
import assert from "node:assert/strict";
import { detectTaxDroppedFromSummary } from "./detect-tax-dropped-from-summary.js";

const order = (over = {}) => ({
  total: 120.0,
  tax_total: 20.0,
  summary: {
    accounting_total: 100.0,
    current_order_total: 100.0,
    pending_difference: -20.0,
    paid_total: 120.0,
  },
  ...over,
});

test("affected when drift matches tax_total", () => {
  const result = detectTaxDroppedFromSummary(order());
  assert.equal(result.affected, true);
  assert.equal(result.drift, 20.0);
  assert.equal(result.correctedPendingDifference, 0.0);
});

test("not affected when no tax on order", () => {
  const o = order({ tax_total: 0.0, total: 100.0 });
  o.summary.accounting_total = 100.0;
  const result = detectTaxDroppedFromSummary(o);
  assert.equal(result.affected, false);
});

test("not affected with legitimate partial refund", () => {
  const o = order();
  o.summary.accounting_total = 110.0; // only $10 off, not the $20 tax
  const result = detectTaxDroppedFromSummary(o);
  assert.equal(result.affected, false);
});

test("rounding noise within epsilon still affected", () => {
  const o = order();
  o.summary.accounting_total = 100.004;
  const result = detectTaxDroppedFromSummary(o);
  assert.equal(result.affected, true);
});

test("rounding noise outside epsilon not affected", () => {
  const o = order();
  o.summary.accounting_total = 99.9; // off by 0.1 beyond the 20.0 tax match
  const result = detectTaxDroppedFromSummary(o);
  assert.equal(result.affected, false);
});

test("corrected pending difference uses total minus paid", () => {
  const o = order({ total: 150.0 });
  o.summary.paid_total = 90.0;
  const result = detectTaxDroppedFromSummary(o);
  assert.equal(result.correctedPendingDifference, 60.0);
});
