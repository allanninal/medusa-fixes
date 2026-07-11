import { test } from "node:test";
import assert from "node:assert/strict";
import { diffEventDelivery } from "./reconcile-event-delivery.js";

const WINDOW_START = "2026-07-09T00:00:00Z";
const WINDOW_END = "2026-07-10T00:00:00Z";

const order = (over = {}) => ({
  id: "order_1",
  created_at: "2026-07-09T12:00:00Z",
  ...over,
});

const notification = (over = {}) => ({
  resource_id: "order_1",
  resource_type: "order",
  event_name: "order.placed",
  created_at: "2026-07-09T12:00:10Z",
  ...over,
});

test("delivered when notification arrives quickly", () => {
  const result = diffEventDelivery([order()], [notification()], WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [{ order_id: "order_1", status: "delivered", delay_ms: 10000 }]);
});

test("delayed when notification arrives past threshold", () => {
  const late = notification({ created_at: "2026-07-09T12:05:00Z" });
  const result = diffEventDelivery([order()], [late], WINDOW_START, WINDOW_END, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", status: "delayed", delay_ms: 300000 }]);
});

test("dropped when no matching notification", () => {
  const result = diffEventDelivery([order()], [], WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [{ order_id: "order_1", status: "dropped", delay_ms: null }]);
});

test("ignores notification for a different event", () => {
  const otherEvent = notification({ event_name: "order.fulfillment_created" });
  const result = diffEventDelivery([order()], [otherEvent], WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [{ order_id: "order_1", status: "dropped", delay_ms: null }]);
});

test("ignores notification for a different resource type", () => {
  const otherType = notification({ resource_type: "customer" });
  const result = diffEventDelivery([order()], [otherType], WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [{ order_id: "order_1", status: "dropped", delay_ms: null }]);
});

test("uses the earliest matching notification", () => {
  const first = notification({ created_at: "2026-07-09T12:00:05Z" });
  const second = notification({ created_at: "2026-07-09T12:10:00Z" });
  const result = diffEventDelivery([order()], [second, first], WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [{ order_id: "order_1", status: "delivered", delay_ms: 5000 }]);
});

test("handles multiple orders independently", () => {
  const orders = [order(), order({ id: "order_2", created_at: "2026-07-09T13:00:00Z" })];
  const notifications = [notification()];
  const result = diffEventDelivery(orders, notifications, WINDOW_START, WINDOW_END);
  assert.deepEqual(result, [
    { order_id: "order_1", status: "delivered", delay_ms: 10000 },
    { order_id: "order_2", status: "dropped", delay_ms: null },
  ]);
});

test("exactly at threshold is delivered", () => {
  const atThreshold = notification({ created_at: "2026-07-09T12:01:00Z" });
  const result = diffEventDelivery([order()], [atThreshold], WINDOW_START, WINDOW_END, 60000);
  assert.deepEqual(result, [{ order_id: "order_1", status: "delivered", delay_ms: 60000 }]);
});
