import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReservation } from "./reconcile-half-run-workflows.js";

const NOW = "2026-07-10T00:20:00Z";

const reservation = (over = {}) => ({
  id: "res_1",
  line_item_id: "item_1",
  created_at: "2026-07-10T00:00:00Z",
  ...over,
});

test("healthy when no line_item_id", () => {
  const r = reservation({ line_item_id: null });
  assert.equal(classifyReservation(r, null, NOW, 10), "healthy");
});

test("orphaned_no_order when order missing", () => {
  const r = reservation();
  assert.equal(classifyReservation(r, null, NOW, 10), "orphaned_no_order");
});

test("orphaned_canceled_order when order canceled", () => {
  const order = { id: "order_1", status: "canceled" };
  const r = reservation();
  assert.equal(classifyReservation(r, order, NOW, 10), "orphaned_canceled_order");
});

test("healthy when order pending even if old", () => {
  const order = { id: "order_1", status: "pending" };
  const r = reservation();
  assert.equal(classifyReservation(r, order, NOW, 10), "healthy");
});

test("stale_pending_review when old and order in limbo", () => {
  const order = { id: "order_1", status: "requires_action" };
  const r = reservation();
  assert.equal(classifyReservation(r, order, NOW, 10), "stale_pending_review");
});

test("healthy when young even if order in limbo", () => {
  const order = { id: "order_1", status: "requires_action" };
  const r = reservation({ created_at: "2026-07-10T00:15:00Z" });
  assert.equal(classifyReservation(r, order, NOW, 10), "healthy");
});

test("healthy when order completed even if old", () => {
  const order = { id: "order_1", status: "completed" };
  const r = reservation();
  assert.equal(classifyReservation(r, order, NOW, 10), "healthy");
});
