import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRefund } from "./refund-from-ledger.js";

const payment = (over = {}) => ({ amount: 100.0, amount_refunded: 0.0, captured_at: "2026-07-01T00:00:00Z", ...over });
const summary = (over = {}) => ({ transaction_total: 100.0, paid_total: 100.0, refunded_total: 0.0, ...over });

test("allows refund when captured and summary agrees", () => {
  const result = decideRefund(payment(), summary(), 100.0);
  assert.equal(result.allow, true);
  assert.equal(result.refundable_amount, "100");
  assert.equal(result.reason, undefined);
});

test("blocks when not captured", () => {
  const result = decideRefund(payment({ captured_at: null }), summary(), 100.0);
  assert.equal(result.allow, false);
  assert.equal(result.reason, "not_captured");
});

test("blocks when requested exceeds refundable", () => {
  const result = decideRefund(payment({ amount_refunded: 40.0 }), summary({ refunded_total: 0.0 }), 100.0);
  assert.equal(result.allow, false);
  assert.equal(result.reason, "exceeds_refundable");
});

test("allows when summary reads zero outstanding but payment is captured", () => {
  // This is the exact bug: the order summary thinks nothing is owed,
  // but the payment ledger says it is still fully refundable.
  const result = decideRefund(payment(), summary({ paid_total: 100.0, refunded_total: 100.0 }), 100.0);
  assert.equal(result.allow, true);
  assert.equal(result.reason, "summary_outstanding_zero_but_payment_captured");
  assert.equal(result.refundable_amount, "100");
});

test("partial refund within remaining amount", () => {
  const result = decideRefund(payment({ amount_refunded: 60.0 }), summary({ refunded_total: 60.0 }), 40.0);
  assert.equal(result.allow, true);
  assert.equal(result.refundable_amount, "40");
});

test("zero refundable payment is not allowed for positive request", () => {
  const result = decideRefund(payment({ amount_refunded: 100.0 }), summary({ refunded_total: 100.0 }), 1.0);
  assert.equal(result.allow, false);
  assert.equal(result.reason, "exceeds_refundable");
});

test("requesting exactly the refundable amount is allowed", () => {
  const result = decideRefund(payment({ amount: 250.0, amount_refunded: 0.0 }), summary({ paid_total: 250.0, refunded_total: 0.0 }), 250.0);
  assert.equal(result.allow, true);
  assert.equal(result.refundable_amount, "250");
});
