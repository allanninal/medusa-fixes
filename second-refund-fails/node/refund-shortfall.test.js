import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRefundShortfall } from "./refund-shortfall.js";

const payment = (over = {}) => ({
  id: "pay_1",
  captures: [{ raw_amount: 100.0 }],
  refunds: [],
  ...over,
});

test("silently blocked when payment has headroom but order reads zero", () => {
  const p = payment({ refunds: [{ raw_amount: 40.0 }] });
  const result = computeRefundShortfall(p, 0);
  assert.equal(result.capturedTotal, 100.0);
  assert.equal(result.refundedTotal, 40.0);
  assert.equal(result.shortfall, 60.0);
  assert.equal(result.isSilentlyBlocked, true);
});

test("not blocked when order still shows a balance", () => {
  const p = payment({ refunds: [{ raw_amount: 40.0 }] });
  const result = computeRefundShortfall(p, 60.0);
  assert.equal(result.isSilentlyBlocked, false);
});

test("not blocked when fully refunded", () => {
  const p = payment({ refunds: [{ raw_amount: 100.0 }] });
  const result = computeRefundShortfall(p, 0);
  assert.equal(result.shortfall, 0.0);
  assert.equal(result.isSilentlyBlocked, false);
});

test("sums multiple captures and refunds", () => {
  const p = payment({
    captures: [{ raw_amount: 50.0 }, { raw_amount: 50.0 }],
    refunds: [{ raw_amount: 20.0 }, { raw_amount: 20.0 }],
  });
  const result = computeRefundShortfall(p, 0);
  assert.equal(result.capturedTotal, 100.0);
  assert.equal(result.refundedTotal, 40.0);
  assert.equal(result.shortfall, 60.0);
  assert.equal(result.isSilentlyBlocked, true);
});

test("negative order pending difference still counts as blocked", () => {
  const p = payment({ refunds: [{ raw_amount: 40.0 }] });
  const result = computeRefundShortfall(p, -5.0);
  assert.equal(result.isSilentlyBlocked, true);
});

test("within epsilon shortfall is not blocked", () => {
  const p = payment({ captures: [{ raw_amount: 100.0 }], refunds: [{ raw_amount: 99.995 }] });
  const result = computeRefundShortfall(p, 0);
  assert.equal(result.isSilentlyBlocked, false);
});

test("no captures means zero shortfall", () => {
  const p = payment({ captures: [], refunds: [] });
  const result = computeRefundShortfall(p, 0);
  assert.equal(result.capturedTotal, 0.0);
  assert.equal(result.shortfall, 0.0);
  assert.equal(result.isSilentlyBlocked, false);
});
