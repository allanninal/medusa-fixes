import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefundReconciliation } from "./reconcile-refunds.js";

function order({ paidTotal = 100.0, refundedTotal = 0.0, payments = [] } = {}) {
  return {
    id: "order_1",
    summary: {
      paid_total: paidTotal,
      refunded_total: refundedTotal,
      transaction_total: paidTotal,
      accounting_total: paidTotal - refundedTotal,
    },
    payment_collections: [{ status: "authorized", payments }],
  };
}

function payment({ amount = 100.0, refunds = [] } = {}) {
  return { amount, captured_at: "2026-07-01T00:00:00Z", refunds };
}

test("in sync when ledger matches order", () => {
  const o = order({
    refundedTotal: 20.0,
    payments: [payment({ refunds: [{ amount: 20.0, created_at: "2026-07-02T00:00:00Z" }] })],
  });
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, false);
  assert.equal(result.reason, "in_sync");
  assert.equal(result.delta, 0.0);
});

test("refund not reflected when ledger ahead", () => {
  const o = order({
    refundedTotal: 0.0,
    payments: [payment({ refunds: [{ amount: 25.0, created_at: "2026-07-02T00:00:00Z" }] })],
  });
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, true);
  assert.equal(result.reason, "refund_not_reflected");
  assert.equal(result.ledgerRefundedTotal, 25.0);
  assert.equal(result.delta, 25.0);
});

test("over refunded on order when order ahead", () => {
  const o = order({
    refundedTotal: 30.0,
    payments: [payment({ refunds: [{ amount: 10.0, created_at: "2026-07-02T00:00:00Z" }] })],
  });
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, true);
  assert.equal(result.reason, "over_refunded_on_order");
  assert.equal(result.delta, -20.0);
});

test("sums refunds across multiple payments", () => {
  const o = order({
    refundedTotal: 15.0,
    payments: [
      payment({ amount: 50.0, refunds: [{ amount: 10.0, created_at: "2026-07-02T00:00:00Z" }] }),
      payment({ amount: 50.0, refunds: [{ amount: 5.0, created_at: "2026-07-03T00:00:00Z" }] }),
    ],
  });
  const result = decideRefundReconciliation(o);
  assert.equal(result.ledgerRefundedTotal, 15.0);
  assert.equal(result.needsSync, false);
});

test("within epsilon counts as in sync", () => {
  const o = order({
    refundedTotal: 19.995,
    payments: [payment({ refunds: [{ amount: 20.0, created_at: "2026-07-02T00:00:00Z" }] })],
  });
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, false);
  assert.equal(result.reason, "in_sync");
});

test("no payment collections is in sync when order shows zero", () => {
  const o = {
    id: "order_2",
    summary: { paid_total: 0, refunded_total: 0, transaction_total: 0, accounting_total: 0 },
    payment_collections: [],
  };
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, false);
  assert.equal(result.ledgerRefundedTotal, 0);
});

test("missing summary defaults order refunded total to zero", () => {
  const o = {
    id: "order_3",
    payment_collections: [
      { status: "authorized", payments: [payment({ refunds: [{ amount: 12.0, created_at: "2026-07-02T00:00:00Z" }] })] },
    ],
  };
  const result = decideRefundReconciliation(o);
  assert.equal(result.needsSync, true);
  assert.equal(result.reason, "refund_not_reflected");
  assert.equal(result.ledgerRefundedTotal, 12.0);
});
