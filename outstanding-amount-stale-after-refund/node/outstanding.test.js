import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStaleOutstanding } from "./detect-stale-outstanding.js";

const order = (over = {}) => ({
  total: 100.0,
  captures: [{ amount: 100.0 }],
  refunds: [{ id: "ref_1", amount: 20.0, created_at: "2026-07-01T00:00:00Z" }],
  reportedOutstanding: 0.0,
  ...over,
});

test("not affected with a single refund in sync", () => {
  const result = detectStaleOutstanding(order());
  assert.equal(result.affected, false);
  assert.equal(result.refundCount, 1);
});

test("affected when second refund never moved the summary", () => {
  // true outstanding = 100 - 100 + 40 = 40, but the summary still reports
  // the balance from after refund #1 only (20.0), so it is stale.
  const refunds = [
    { id: "ref_1", amount: 20.0, created_at: "2026-07-01T00:00:00Z" },
    { id: "ref_2", amount: 20.0, created_at: "2026-07-05T00:00:00Z" },
  ];
  const result = detectStaleOutstanding(order({ refunds, reportedOutstanding: 20.0 }));
  assert.equal(result.affected, true);
  assert.equal(result.trueOutstanding, 40.0);
  assert.equal(result.delta, -20.0);
  assert.equal(result.refundCount, 2);
});

test("not affected when multiple refunds but summary matches", () => {
  const refunds = [
    { id: "ref_1", amount: 20.0, created_at: "2026-07-01T00:00:00Z" },
    { id: "ref_2", amount: 20.0, created_at: "2026-07-05T00:00:00Z" },
  ];
  const result = detectStaleOutstanding(order({ refunds, reportedOutstanding: 40.0 }));
  assert.equal(result.affected, false);
});

test("rounding epsilon does not false positive", () => {
  const refunds = [
    { id: "ref_1", amount: 20.0, created_at: "2026-07-01T00:00:00Z" },
    { id: "ref_2", amount: 20.0, created_at: "2026-07-05T00:00:00Z" },
  ];
  const result = detectStaleOutstanding(order({ refunds, reportedOutstanding: 40.005 }));
  assert.equal(result.affected, false);
});

test("true outstanding computed from captures and refunds", () => {
  const result = detectStaleOutstanding(order({ total: 150.0, captures: [{ amount: 100.0 }], refunds: [] }));
  assert.equal(result.trueOutstanding, 50.0);
  assert.equal(result.refundCount, 0);
  assert.equal(result.affected, false);
});

test("single refund with a mismatch is not flagged", () => {
  const result = detectStaleOutstanding(order({ reportedOutstanding: 999.0 }));
  assert.equal(result.affected, false);
  assert.equal(result.refundCount, 1);
});

test("delta sign when reported is lower than true", () => {
  // true outstanding = 100 - 100 + 40 = 40; reported is only 0.0, so the
  // summary under-reports what is actually still outstanding (delta < 0).
  const refunds = [
    { id: "ref_1", amount: 20.0, created_at: "2026-07-01T00:00:00Z" },
    { id: "ref_2", amount: 20.0, created_at: "2026-07-05T00:00:00Z" },
  ];
  const result = detectStaleOutstanding(order({ refunds, reportedOutstanding: 0.0 }));
  assert.equal(result.affected, true);
  assert.equal(result.delta, -40.0);
});
