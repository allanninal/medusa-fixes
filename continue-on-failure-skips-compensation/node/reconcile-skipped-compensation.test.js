import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrphan } from "./reconcile-skipped-compensation.js";

const order = (over = {}) => ({
  id: "order_1",
  payment_status: "captured",
  fulfillment_status: "not_fulfilled",
  payments: [{ status: "captured" }],
  fulfillments: [],
  items: [{ id: "item_1", quantity: 1 }],
  ...over,
});

const CONTINUE_FAILED_STEP = [{ action: "captureStep.continueOnPermanentFailure", handlerType: "invoke" }];
const RESERVE_FAILED_STEP = [{ action: "reserveInventoryStep", handlerType: "invoke" }];

test("orphaned_payment_no_fulfillment when captured and unfulfilled", () => {
  assert.equal(classifyOrphan(order(), CONTINUE_FAILED_STEP), "orphaned_payment_no_fulfillment");
});

test("ok when no failed steps", () => {
  assert.equal(classifyOrphan(order(), []), "ok");
});

test("ok when fulfillment exists", () => {
  const o = order({ fulfillments: [{ id: "ful_1" }] });
  assert.equal(classifyOrphan(o, CONTINUE_FAILED_STEP), "ok");
});

test("ok when payment not captured", () => {
  const o = order({ payment_status: "not_paid", payments: [] });
  assert.equal(classifyOrphan(o, CONTINUE_FAILED_STEP), "ok");
});

test("orphaned_reservation_no_order_line when items empty", () => {
  const o = order({ items: [], payment_status: "not_paid", payments: [] });
  assert.equal(classifyOrphan(o, RESERVE_FAILED_STEP), "orphaned_reservation_no_order_line");
});

test("ok when reservation failed but items still present", () => {
  assert.equal(classifyOrphan(order(), RESERVE_FAILED_STEP), "ok");
});

test("ok when continueOnPermanentFailure step is a compensate entry", () => {
  const step = [{ action: "captureStep.continueOnPermanentFailure", handlerType: "compensate" }];
  assert.equal(classifyOrphan(order(), step), "ok");
});
