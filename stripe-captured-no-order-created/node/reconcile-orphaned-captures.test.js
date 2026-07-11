import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReconciliation } from "./reconcile-orphaned-captures.js";

const GRACE_MS = 10 * 60 * 1000;
const NOW_MS = 1_800_000_000_000;

const call = (over = {}) => decideReconciliation({
  stripePaymentIntentId: "pi_123",
  stripeStatus: "succeeded",
  capturedAtMs: NOW_MS - GRACE_MS * 2,
  nowMs: NOW_MS,
  graceMs: GRACE_MS,
  medusaPaymentDataIds: [],
  cartCompletedAt: null,
  cartHasOrderId: false,
  ...over,
});

test("orphaned when captured, unmatched, and cart incomplete", () => {
  assert.equal(call(), "orphaned_capture_needs_manual_complete");
});

test("already reconciled when matched and cart completed", () => {
  const result = call({ medusaPaymentDataIds: ["pi_123"], cartCompletedAt: "2026-07-10T00:00:00Z" });
  assert.equal(result, "already_reconciled");
});

test("already reconciled when matched and has order", () => {
  const result = call({ medusaPaymentDataIds: ["pi_123"], cartHasOrderId: true });
  assert.equal(result, "already_reconciled");
});

test("ok when stripe status is not succeeded", () => {
  assert.equal(call({ stripeStatus: "processing" }), "ok");
});

test("too recent within grace window", () => {
  const result = call({ capturedAtMs: NOW_MS - 1000 });
  assert.equal(result, "too_recent");
});

test("ok when matched but cart still incomplete", () => {
  const result = call({ medusaPaymentDataIds: ["pi_123"] });
  assert.equal(result, "ok");
});

test("exactly at grace boundary is flagged", () => {
  const result = call({ capturedAtMs: NOW_MS - GRACE_MS });
  assert.equal(result, "orphaned_capture_needs_manual_complete");
});

test("not flagged when cancelled", () => {
  assert.equal(call({ stripeStatus: "canceled" }), "ok");
});

test("not flagged when requires_capture", () => {
  assert.equal(call({ stripeStatus: "requires_capture" }), "ok");
});
