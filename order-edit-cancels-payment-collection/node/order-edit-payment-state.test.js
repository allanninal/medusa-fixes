import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderPaymentEditState } from "./flag-edit-cancels-payment.js";

const order = (over = {}) => ({
  id: "order_1",
  payment_status: "not_paid",
  summary: { raw_difference_due: 5000 },
  payment_collections: [
    { id: "paycol_1", status: "canceled", amount: 5000 },
  ],
  ...over,
});

test("blocked when only canceled collection and amount due", () => {
  const result = classifyOrderPaymentEditState(order());
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "canceled_collection_blocks_capture");
  assert.equal(result.canceledCollectionId, "paycol_1");
  assert.equal(result.amountDue, 5000);
});

test("not blocked when healthy paid order", () => {
  const o = order({ payment_status: "captured", summary: { raw_difference_due: 0 } });
  const result = classifyOrderPaymentEditState(o);
  assert.deepEqual(result, { blocked: false, reason: null, canceledCollectionId: null, amountDue: 0 });
});

test("not blocked when an active collection exists", () => {
  const o = order({
    payment_collections: [
      { id: "paycol_1", status: "canceled", amount: 5000 },
      { id: "paycol_2", status: "not_paid", amount: 5000 },
    ],
  });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, false);
});

test("blocked with only canceled collection and outstanding balance", () => {
  const o = order({
    payment_collections: [{ id: "paycol_9", status: "canceled", amount: 12000 }],
    summary: { raw_difference_due: 12000 },
  });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, true);
  assert.equal(result.canceledCollectionId, "paycol_9");
  assert.equal(result.amountDue, 12000);
});

test("not blocked when fully refunded or canceled with no amount due", () => {
  const o = order({ summary: { raw_difference_due: 0 } });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, false);
});

test("not blocked when payment_status is not not_paid", () => {
  const o = order({ payment_status: "awaiting" });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, false);
});

test("falls back to summing uncaptured collections when summary missing", () => {
  const o = order({
    summary: {},
    payment_collections: [{ id: "paycol_1", status: "canceled", amount: 3000 }],
  });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, true);
  assert.equal(result.amountDue, 3000);
});

test("not blocked when amount due is zero even with canceled collection", () => {
  const o = order({ summary: { raw_difference_due: 0 } });
  const result = classifyOrderPaymentEditState(o);
  assert.equal(result.blocked, false);
  assert.equal(result.amountDue, 0);
});
