import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOrderTransactionRepair } from "./find-missing-order-transactions.js";

const order = (over = {}) => ({ id: "order_1", currencyCode: "usd", paidTotal: 0, ...over });
const payment = (over = {}) => ({ id: "pay_1", amount: 100, capturedAt: "2026-07-10T00:00:00Z", canceledAt: null, ...over });

test("creates transaction when single captured payment missing ref", () => {
  const result = decideOrderTransactionRepair(order(), [payment()], new Set());
  assert.equal(result.action, "create_transaction");
  assert.equal(result.orderId, "order_1");
  assert.equal(result.paymentId, "pay_1");
  assert.equal(result.missingAmount, 100);
});

test("noop when no payments captured", () => {
  const result = decideOrderTransactionRepair(order(), [payment({ capturedAt: null })], new Set());
  assert.equal(result.action, "noop");
});

test("noop when captured payment already has ref", () => {
  const result = decideOrderTransactionRepair(order({ paidTotal: 100 }), [payment()], new Set(["pay_1"]));
  assert.equal(result.action, "noop");
});

test("noop when canceled even if capturedAt is set", () => {
  const result = decideOrderTransactionRepair(order(), [payment({ canceledAt: "2026-07-11T00:00:00Z" })], new Set());
  assert.equal(result.action, "noop");
});

test("flags ambiguous when multiple captured payments", () => {
  const payments = [payment({ id: "pay_1" }), payment({ id: "pay_2" })];
  const result = decideOrderTransactionRepair(order(), payments, new Set());
  assert.equal(result.action, "flag_ambiguous");
});

test("flags ambiguous when partial reference coverage", () => {
  const payments = [payment({ id: "pay_1" }), payment({ id: "pay_2" })];
  const result = decideOrderTransactionRepair(order(), payments, new Set(["pay_1"]));
  assert.equal(result.action, "flag_ambiguous");
});

test("noop when paidTotal already matches expected", () => {
  const result = decideOrderTransactionRepair(order({ paidTotal: 100 }), [payment()], new Set());
  assert.equal(result.action, "noop");
});

test("missingAmount accounts for partial existing paidTotal", () => {
  const result = decideOrderTransactionRepair(order({ paidTotal: 40 }), [payment({ amount: 100 })], new Set());
  assert.equal(result.action, "create_transaction");
  assert.equal(result.missingAmount, 60);
});
