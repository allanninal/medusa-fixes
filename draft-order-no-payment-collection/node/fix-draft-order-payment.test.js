import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDraftOrderPaymentAction } from "./fix-draft-order-payment.js";

const order = (over = {}) => ({
  isDraftOrder: true,
  status: "pending",
  hasCartId: false,
  paymentCollections: [],
  pendingDifference: 5000,
  ...over,
});

test("flags stuck when no collection and amount pending", () => {
  assert.equal(decideDraftOrderPaymentAction(order()), "FLAG_STUCK_NO_PAYMENT");
});

test("ok when not a draft order", () => {
  assert.equal(decideDraftOrderPaymentAction(order({ isDraftOrder: false })), "OK");
});

test("ok when completed", () => {
  assert.equal(decideDraftOrderPaymentAction(order({ status: "completed" })), "OK");
});

test("ok when payment collection already exists", () => {
  const o = order({ paymentCollections: [{ id: "paycol_1", status: "not_paid" }] });
  assert.equal(decideDraftOrderPaymentAction(o), "OK");
});

test("ok when nothing pending", () => {
  assert.equal(decideDraftOrderPaymentAction(order({ pendingDifference: 0 })), "OK");
});

test("needs order payment collection when cart_id present", () => {
  const o = order({ hasCartId: true });
  assert.equal(decideDraftOrderPaymentAction(o), "NEEDS_ORDER_PAYMENT_COLLECTION");
});

test("flag stuck takes priority over a false missing cart read", () => {
  const o = order({ hasCartId: false, pendingDifference: 125.5 });
  assert.equal(decideDraftOrderPaymentAction(o), "FLAG_STUCK_NO_PAYMENT");
});

test("ok when negative pending difference", () => {
  const o = order({ pendingDifference: -10 });
  assert.equal(decideDraftOrderPaymentAction(o), "OK");
});
