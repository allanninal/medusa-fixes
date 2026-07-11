import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBalanceAction, reportedDirection } from "./flag-wrong-balance-direction.js";

test("cheaper swap expects refund", () => {
  const result = decideBalanceAction(4000, 6000);
  assert.equal(result.direction, "refund");
  assert.equal(result.pendingDifference, -2000);
});

test("pricier swap expects collect", () => {
  const result = decideBalanceAction(8000, 6000);
  assert.equal(result.direction, "collect");
  assert.equal(result.pendingDifference, 2000);
});

test("no-op edit expects none", () => {
  const result = decideBalanceAction(6000, 6000);
  assert.equal(result.direction, "none");
  assert.equal(result.pendingDifference, 0);
});

test("operands are never fed swapped", () => {
  // The exact regression in #13068 is feeding (paidTotal, currentOrderTotal)
  // instead of (currentOrderTotal, paidTotal). Swapping the arguments here
  // must flip the sign, proving the function is order-sensitive as intended.
  const forward = decideBalanceAction(4000, 6000);
  const swapped = decideBalanceAction(6000, 4000);
  assert.notEqual(forward.direction, swapped.direction);
  assert.equal(forward.pendingDifference, -swapped.pendingDifference);
});

test("reportedDirection reads negative as refund", () => {
  assert.equal(reportedDirection({ summary: { pending_difference: -1500 } }), "refund");
});

test("reportedDirection reads positive as collect", () => {
  assert.equal(reportedDirection({ summary: { pending_difference: 1500 } }), "collect");
});

test("reportedDirection missing summary is null", () => {
  assert.equal(reportedDirection({ summary: {} }), null);
});
