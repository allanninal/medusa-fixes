import { test } from "node:test";
import assert from "node:assert/strict";
import { isPriceListExpiredButActive, pickBestCalculatedPrice } from "./flag-expired-price-lists.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const priceList = (over = {}) => ({ status: "active", ends_at: null, ...over });

test("true when active and ends_at in past", () => {
  const pl = priceList({ ends_at: "2020-01-01T00:00:00Z" });
  assert.equal(isPriceListExpiredButActive(pl, NOW), true);
});

test("false when ends_at is null", () => {
  const pl = priceList({ ends_at: null });
  assert.equal(isPriceListExpiredButActive(pl, NOW), false);
});

test("false when status is draft", () => {
  const pl = priceList({ status: "draft", ends_at: "2020-01-01T00:00:00Z" });
  assert.equal(isPriceListExpiredButActive(pl, NOW), false);
});

test("false when ends_at in future", () => {
  const pl = priceList({ ends_at: "2030-01-01T00:00:00Z" });
  assert.equal(isPriceListExpiredButActive(pl, NOW), false);
});

test("false when ends_at exactly now", () => {
  const pl = priceList({ ends_at: "2026-07-10T00:00:00Z" });
  assert.equal(isPriceListExpiredButActive(pl, NOW), false);
});

test("pick best price skips expired price list candidate", () => {
  const candidates = [
    { id: "price_expired", amount: 10, price_list_id: "plist_1", price_list_ends_at: "2020-01-01T00:00:00Z", price_list_status: "active" },
    { id: "price_default", amount: 50, price_list_id: null, price_list_ends_at: null, price_list_status: null },
  ];
  assert.deepEqual(pickBestCalculatedPrice(candidates, NOW), { id: "price_default", amount: 50 });
});

test("pick best price skips draft price list candidate", () => {
  const candidates = [
    { id: "price_draft", amount: 5, price_list_id: "plist_2", price_list_ends_at: null, price_list_status: "draft" },
    { id: "price_default", amount: 50, price_list_id: null, price_list_ends_at: null, price_list_status: null },
  ];
  assert.deepEqual(pickBestCalculatedPrice(candidates, NOW), { id: "price_default", amount: 50 });
});

test("pick best price uses live active price list when not expired", () => {
  const candidates = [
    { id: "price_sale", amount: 20, price_list_id: "plist_3", price_list_ends_at: "2030-01-01T00:00:00Z", price_list_status: "active" },
    { id: "price_default", amount: 50, price_list_id: null, price_list_ends_at: null, price_list_status: null },
  ];
  assert.deepEqual(pickBestCalculatedPrice(candidates, NOW), { id: "price_sale", amount: 20 });
});

test("pick best price returns null when all candidates excluded", () => {
  const candidates = [
    { id: "price_expired", amount: 10, price_list_id: "plist_4", price_list_ends_at: "2020-01-01T00:00:00Z", price_list_status: "active" },
  ];
  assert.equal(pickBestCalculatedPrice(candidates, NOW), null);
});

test("pick best price breaks ties by first lowest", () => {
  const candidates = [
    { id: "price_a", amount: 30, price_list_id: null, price_list_ends_at: null, price_list_status: null },
    { id: "price_b", amount: 30, price_list_id: null, price_list_ends_at: null, price_list_status: null },
  ];
  const result = pickBestCalculatedPrice(candidates, NOW);
  assert.equal(result.amount, 30);
  assert.ok(["price_a", "price_b"].includes(result.id));
});

test("pick best price empty list returns null", () => {
  assert.equal(pickBestCalculatedPrice([], NOW), null);
});
