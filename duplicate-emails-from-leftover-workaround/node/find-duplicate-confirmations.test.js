import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateNotifications } from "./find-duplicate-confirmations.js";

const notification = (over = {}) => ({
  id: "notif_1",
  resource_id: "order_1",
  resource_type: "order",
  to: "buyer@example.com",
  created_at: "2026-07-10T12:00:00Z",
  ...over,
});

test("flags two sends within window", () => {
  const notifications = [
    notification({ id: "notif_1", created_at: "2026-07-10T12:00:00Z" }),
    notification({ id: "notif_2", created_at: "2026-07-10T12:00:20Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", count: 2, notification_ids: ["notif_1", "notif_2"] }]);
});

test("does not flag a single send", () => {
  const result = findDuplicateNotifications([notification()], 60000);
  assert.deepEqual(result, []);
});

test("does not flag sends outside the window", () => {
  const notifications = [
    notification({ id: "notif_1", created_at: "2026-07-10T12:00:00Z" }),
    notification({ id: "notif_2", created_at: "2026-07-10T12:05:00Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, []);
});

test("ignores non-order resource type", () => {
  const notifications = [
    notification({ id: "notif_1", resource_type: "customer" }),
    notification({ id: "notif_2", resource_type: "customer", created_at: "2026-07-10T12:00:10Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, []);
});

test("does not cluster different recipients", () => {
  const notifications = [
    notification({ id: "notif_1", to: "buyer@example.com" }),
    notification({ id: "notif_2", to: "other@example.com", created_at: "2026-07-10T12:00:10Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, []);
});

test("handles multiple orders independently", () => {
  const notifications = [
    notification({ id: "notif_1", resource_id: "order_1", created_at: "2026-07-10T12:00:00Z" }),
    notification({ id: "notif_2", resource_id: "order_1", created_at: "2026-07-10T12:00:10Z" }),
    notification({ id: "notif_3", resource_id: "order_2", created_at: "2026-07-10T13:00:00Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", count: 2, notification_ids: ["notif_1", "notif_2"] }]);
});

test("three sends in one cluster", () => {
  const notifications = [
    notification({ id: "notif_1", created_at: "2026-07-10T12:00:00Z" }),
    notification({ id: "notif_2", created_at: "2026-07-10T12:00:10Z" }),
    notification({ id: "notif_3", created_at: "2026-07-10T12:00:20Z" }),
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", count: 3, notification_ids: ["notif_1", "notif_2", "notif_3"] }]);
});

test("exactly at window boundary is clustered", () => {
  const notifications = [
    notification({ id: "notif_1", created_at: "2026-07-10T12:00:00Z" }),
    notification({ id: "notif_2", created_at: "2026-07-10T12:01:00Z" }), // exactly 60000ms later
  ];
  const result = findDuplicateNotifications(notifications, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", count: 2, notification_ids: ["notif_1", "notif_2"] }]);
});
