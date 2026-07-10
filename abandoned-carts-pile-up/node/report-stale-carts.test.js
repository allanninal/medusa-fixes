import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStaleCart } from "./report-stale-carts.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const cart = (over = {}) => ({
  id: "cart_1",
  completed_at: null,
  updated_at: "2026-06-01T00:00:00Z",
  item_count: 2,
  ...over,
});

test("stale when old with items", () => {
  const result = classifyStaleCart(cart(), NOW, 30);
  assert.equal(result.stale, true);
  assert.ok(result.reason.startsWith("inactive-"));
});

test("not stale when completed", () => {
  const result = classifyStaleCart(cart({ completed_at: "2026-06-02T00:00:00Z" }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "completed" });
});

test("not stale when empty cart", () => {
  const result = classifyStaleCart(cart({ item_count: 0 }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "empty-cart-not-abandoned" });
});

test("not stale when recent", () => {
  const result = classifyStaleCart(cart({ updated_at: "2026-07-09T00:00:00Z" }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "recent" });
});

test("exactly at stale window is stale", () => {
  const result = classifyStaleCart(cart({ updated_at: "2026-06-10T00:00:00Z" }), NOW, 30);
  assert.equal(result.stale, true);
});

test("completed wins even with items and age", () => {
  const result = classifyStaleCart(cart({ completed_at: "2026-01-01T00:00:00Z", item_count: 5 }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "completed" });
});
