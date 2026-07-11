import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrderChange, findStuckChanges } from "./reconcile-stuck-order-change.js";

const NOW = new Date("2026-07-10T12:00:00Z");

const change = (over = {}) => ({
  status: "pending",
  confirmed_at: null,
  declined_at: null,
  canceled_at: null,
  updated_at: "2026-07-10T09:00:00Z",
  ...over,
});

test("stale stuck when pending and old", () => {
  assert.equal(classifyOrderChange(change(), NOW, 2), "active_stale_stuck");
});

test("active fresh when pending and recent", () => {
  const result = classifyOrderChange(change({ updated_at: "2026-07-10T11:30:00Z" }), NOW, 2);
  assert.equal(result, "active_fresh");
});

test("terminal when confirmed_at set", () => {
  const result = classifyOrderChange(change({ status: "confirmed", confirmed_at: "2026-07-10T09:00:00Z" }), NOW, 2);
  assert.equal(result, "terminal");
});

test("terminal when declined_at set", () => {
  const result = classifyOrderChange(change({ status: "declined", declined_at: "2026-07-10T09:00:00Z" }), NOW, 2);
  assert.equal(result, "terminal");
});

test("terminal when canceled_at set", () => {
  const result = classifyOrderChange(change({ status: "canceled", canceled_at: "2026-07-10T09:00:00Z" }), NOW, 2);
  assert.equal(result, "terminal");
});

test("terminal when status not active", () => {
  const result = classifyOrderChange(change({ status: "confirmed" }), NOW, 2);
  assert.equal(result, "terminal");
});

test("exactly at threshold is not yet stale", () => {
  const result = classifyOrderChange(change({ updated_at: "2026-07-10T10:00:00Z" }), NOW, 2);
  assert.equal(result, "active_fresh");
});

test("just past threshold is stale", () => {
  const result = classifyOrderChange(change({ updated_at: "2026-07-10T09:59:59Z" }), NOW, 2);
  assert.equal(result, "active_stale_stuck");
});

test("terminal wins even if a terminal timestamp is set with an active status", () => {
  const result = classifyOrderChange(change({ canceled_at: "2026-07-10T09:00:00Z" }), NOW, 2);
  assert.equal(result, "terminal");
});

test("findStuckChanges skips orders without a change and returns only stale stuck ones", () => {
  const orders = [
    { id: "order_1", display_id: 1, order_change: null },
    {
      id: "order_2",
      display_id: 2,
      order_change: {
        id: "ordch_1",
        status: "pending",
        confirmed_at: null,
        declined_at: null,
        canceled_at: null,
        updated_at: "2026-07-10T09:00:00Z",
      },
    },
    {
      id: "order_3",
      display_id: 3,
      order_change: {
        id: "ordch_2",
        status: "pending",
        confirmed_at: null,
        declined_at: null,
        canceled_at: null,
        updated_at: "2026-07-10T11:55:00Z",
      },
    },
  ];

  const stuck = findStuckChanges(orders, NOW, 2);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].order_id, "order_2");
  assert.equal(stuck[0].order_change_id, "ordch_1");
});
