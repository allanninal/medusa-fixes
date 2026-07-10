import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleCartLineItems } from "./reconcile-stale-cart-prices.js";

const cart = (over = {}) => ({
  id: "cart_1",
  currency_code: "usd",
  region_id: "reg_1",
  completed_at: null,
  line_items: [
    {
      id: "item_1",
      variant_id: "variant_1",
      unit_price: 1000,
      is_custom_price: false,
      updated_at: "2026-07-01T00:00:00Z",
    },
  ],
  ...over,
});

const liveMap = () =>
  new Map([
    [
      "variant_1:usd:reg_1",
      { amount: 1200, currency_code: "usd", region_id: "reg_1", updated_at: "2026-07-05T00:00:00Z" },
    ],
  ]);

test("flags stale line item touched before price change", () => {
  const result = findStaleCartLineItems([cart()], liveMap());
  assert.deepEqual(result, [{ cart_id: "cart_1", line_item_id: "item_1", old_price: 1000, new_price: 1200 }]);
});

test("skips custom price line item", () => {
  const c = cart();
  c.line_items[0].is_custom_price = true;
  assert.deepEqual(findStaleCartLineItems([c], liveMap()), []);
});

test("skips when price already matches", () => {
  const c = cart();
  c.line_items[0].unit_price = 1200;
  assert.deepEqual(findStaleCartLineItems([c], liveMap()), []);
});

test("skips completed cart", () => {
  const c = cart({ completed_at: "2026-07-06T00:00:00Z" });
  assert.deepEqual(findStaleCartLineItems([c], liveMap()), []);
});

test("skips line item touched after price change", () => {
  const c = cart();
  c.line_items[0].updated_at = "2026-07-06T00:00:00Z";
  assert.deepEqual(findStaleCartLineItems([c], liveMap()), []);
});

test("skips when no live price match", () => {
  assert.deepEqual(findStaleCartLineItems([cart()], new Map()), []);
});

test("multiple carts only flags stale ones", () => {
  const staleCart = cart({ id: "cart_1" });
  const freshCart = cart({ id: "cart_2" });
  freshCart.line_items[0].id = "item_2";
  freshCart.line_items[0].unit_price = 1200;
  const result = findStaleCartLineItems([staleCart, freshCart], liveMap());
  assert.deepEqual(result, [{ cart_id: "cart_1", line_item_id: "item_1", old_price: 1000, new_price: 1200 }]);
});
