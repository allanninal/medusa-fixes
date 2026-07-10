import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrdersMissingNotification } from "./find-missing-notifications.js";

const NOW_MS = Date.parse("2026-07-10T00:00:00Z");
const GRACE_MS = 10 * 60 * 1000;

const order = (over = {}) => ({
  id: "order_1",
  created_at: "2026-07-09T23:00:00Z",
  fulfillment_status: "not_fulfilled",
  ...over,
});

const notification = (over = {}) => ({
  resource_id: "order_1",
  resource_type: "order",
  event_name: "order.placed",
  ...over,
});

test("flags order past grace with no notification", () => {
  const result = findOrdersMissingNotification([order()], [], "order.placed", GRACE_MS, NOW_MS);
  assert.deepEqual(result, [{ order_id: "order_1", expected_event: "order.placed" }]);
});

test("does not flag when notification exists", () => {
  const result = findOrdersMissingNotification([order()], [notification()], "order.placed", GRACE_MS, NOW_MS);
  assert.deepEqual(result, []);
});

test("does not flag within grace window", () => {
  const recent = order({ created_at: "2026-07-09T23:58:00Z" });
  const result = findOrdersMissingNotification([recent], [], "order.placed", GRACE_MS, NOW_MS);
  assert.deepEqual(result, []);
});

test("ignores notification for a different event", () => {
  const result = findOrdersMissingNotification(
    [order()], [notification({ event_name: "order.fulfillment_created" })], "order.placed", GRACE_MS, NOW_MS
  );
  assert.deepEqual(result, [{ order_id: "order_1", expected_event: "order.placed" }]);
});

test("ignores notification for a different resource type", () => {
  const result = findOrdersMissingNotification(
    [order()], [notification({ resource_type: "customer" })], "order.placed", GRACE_MS, NOW_MS
  );
  assert.deepEqual(result, [{ order_id: "order_1", expected_event: "order.placed" }]);
});

test("handles multiple orders independently", () => {
  const orders = [order(), order({ id: "order_2", created_at: "2026-07-09T22:00:00Z" })];
  const notifications = [notification({ resource_id: "order_2" })];
  const result = findOrdersMissingNotification(orders, notifications, "order.placed", GRACE_MS, NOW_MS);
  assert.deepEqual(result, [{ order_id: "order_1", expected_event: "order.placed" }]);
});
