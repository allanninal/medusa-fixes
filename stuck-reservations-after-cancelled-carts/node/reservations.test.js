import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReservation } from "./release-stuck-reservations.js";

const NOW = new Date("2026-07-10T00:00:00Z");
const STALE_AFTER_MS = 24 * 3600 * 1000;

const reservation = (over = {}) => ({
  id: "res_1",
  line_item_id: "item_1",
  created_at: "2026-07-08T00:00:00Z",
  ...over,
});

test("keep when no line_item_id", () => {
  const r = reservation({ line_item_id: null });
  assert.equal(classifyReservation(r, new Map(), NOW, STALE_AFTER_MS), "keep");
});

test("keep when younger than stale window", () => {
  const r = reservation({ created_at: "2026-07-09T23:00:00Z" });
  assert.equal(classifyReservation(r, new Map(), NOW, STALE_AFTER_MS), "keep");
});

test("stale orphan when no matching order", () => {
  const r = reservation();
  assert.equal(classifyReservation(r, new Map(), NOW, STALE_AFTER_MS), "stale_orphan");
});

test("stale canceled order when order is canceled", () => {
  const index = new Map([["item_1", { orderId: "order_1", orderStatus: "canceled" }]]);
  const r = reservation();
  assert.equal(classifyReservation(r, index, NOW, STALE_AFTER_MS), "stale_canceled_order");
});

test("keep when order is still active", () => {
  const index = new Map([["item_1", { orderId: "order_1", orderStatus: "pending" }]]);
  const r = reservation();
  assert.equal(classifyReservation(r, index, NOW, STALE_AFTER_MS), "keep");
});

test("exactly at stale window is stale", () => {
  const r = reservation({ created_at: "2026-07-09T00:00:00Z" });
  assert.equal(classifyReservation(r, new Map(), NOW, STALE_AFTER_MS), "stale_orphan");
});

test("stale orphan when index has entries but not for this line item", () => {
  const index = new Map([["item_2", { orderId: "order_2", orderStatus: "completed" }]]);
  const r = reservation({ line_item_id: "item_1" });
  assert.equal(classifyReservation(r, index, NOW, STALE_AFTER_MS), "stale_orphan");
});
