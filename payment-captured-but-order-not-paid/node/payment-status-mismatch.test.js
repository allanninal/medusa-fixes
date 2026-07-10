import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPaymentStatusMismatch } from "./reconcile-payment-status.js";

const order = (over = {}) => ({
  id: "order_1",
  payment_status: "captured",
  summary: { raw_paid_total: { value: 5000 }, raw_transaction_total: { value: 5000 } },
  payment_collections: [
    {
      status: "captured",
      payments: [
        { captured_at: "2026-07-01T00:00:00Z", captures: [{ raw_amount: { value: 5000 } }] },
      ],
    },
  ],
  ...over,
});

test("no mismatch when everything agrees", () => {
  const result = detectPaymentStatusMismatch(order());
  assert.deepEqual(result, { orderId: "order_1", mismatched: false, reason: null });
});

test("mismatch when captured but status not_paid", () => {
  const result = detectPaymentStatusMismatch(order({ payment_status: "not_paid" }));
  assert.equal(result.mismatched, true);
  assert.match(result.reason, /payment_status is still not_paid/);
});

test("mismatch when captured but paid_total zero", () => {
  const o = order();
  o.summary.raw_paid_total.value = 0;
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.mismatched, true);
  assert.match(result.reason, /raw_paid_total is 0/);
});

test("mismatch when collection status stale", () => {
  const o = order();
  o.payment_collections[0].status = "awaiting";
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.mismatched, true);
});

test("no mismatch when nothing captured", () => {
  const o = order({ payment_status: "not_paid" });
  o.summary.raw_paid_total.value = 0;
  o.payment_collections[0].payments[0].captures = [];
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.mismatched, false);
});

test("sums captures across multiple payment collections", () => {
  const o = order();
  o.payment_collections.push({
    status: "captured",
    payments: [
      { captured_at: "2026-07-02T00:00:00Z", captures: [{ raw_amount: { value: 1500 } }] },
    ],
  });
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.mismatched, false);
});

test("mismatched orderId matches input order", () => {
  const o = order({ id: "order_42", payment_status: "awaiting" });
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.orderId, "order_42");
  assert.equal(result.mismatched, true);
});

test("no mismatch when no payment collections", () => {
  const o = order({ payment_collections: [], payment_status: "not_paid" });
  o.summary.raw_paid_total.value = 0;
  const result = detectPaymentStatusMismatch(o);
  assert.equal(result.mismatched, false);
});
