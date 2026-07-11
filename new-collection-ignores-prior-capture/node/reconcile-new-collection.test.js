import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileOutstandingAmount } from "./reconcile-new-collection.js";

const summary = (over = {}) => ({
  currentOrderTotal: 120.0,
  paidTotal: 100.0,
  refundedTotal: 0.0,
  transactionTotal: 100.0,
  ...over,
});

test("none when nothing owed", () => {
  const result = reconcileOutstandingAmount(summary({ currentOrderTotal: 100.0 }), []);
  assert.equal(result.action, "none");
});

test("none when open collection matches pending difference", () => {
  const collections = [{ id: "paycol_1", amount: 20.0, status: "not_paid" }];
  const result = reconcileOutstandingAmount(summary(), collections);
  assert.equal(result.action, "none");
});

test("recreate when single open collection sized off full total", () => {
  const collections = [{ id: "paycol_1", amount: 120.0, status: "not_paid" }];
  const result = reconcileOutstandingAmount(summary(), collections);
  assert.equal(result.action, "recreate");
  assert.equal(result.correctAmount, 20.0);
  assert.deepEqual(result.staleCollectionIds, ["paycol_1"]);
});

test("flag when multiple open collections are ambiguous", () => {
  const collections = [
    { id: "paycol_1", amount: 70.0, status: "not_paid" },
    { id: "paycol_2", amount: 60.0, status: "awaiting" },
  ];
  const result = reconcileOutstandingAmount(summary(), collections);
  assert.equal(result.action, "flag");
  assert.deepEqual(new Set(result.staleCollectionIds), new Set(["paycol_1", "paycol_2"]));
});

test("none when no prior capture even if over-sized looking", () => {
  const collections = [{ id: "paycol_1", amount: 120.0, status: "not_paid" }];
  const result = reconcileOutstandingAmount(
    summary({ currentOrderTotal: 120.0, paidTotal: 0.0 }),
    collections
  );
  assert.equal(result.action, "none");
});

test("canceled collections are ignored in the open total", () => {
  const collections = [
    { id: "paycol_1", amount: 120.0, status: "canceled" },
    { id: "paycol_2", amount: 20.0, status: "not_paid" },
  ];
  const result = reconcileOutstandingAmount(summary(), collections);
  assert.equal(result.action, "none");
});

test("rounding epsilon does not false positive", () => {
  const collections = [{ id: "paycol_1", amount: 20.004, status: "not_paid" }];
  const result = reconcileOutstandingAmount(summary(), collections);
  assert.equal(result.action, "none");
});

test("refunded total reduces pending difference", () => {
  const result = reconcileOutstandingAmount(
    summary({ currentOrderTotal: 120.0, paidTotal: 100.0, refundedTotal: 20.0 }),
    []
  );
  assert.equal(result.action, "none");
  assert.equal(result.correctAmount, 0.0);
});
