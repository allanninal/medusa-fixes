import { test } from "node:test";
import assert from "node:assert/strict";
import { getPriceListEffectiveState, hasMatchingPrice, audit } from "./audit-price-lists.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const priceList = (over = {}) => ({ status: "active", starts_at: null, ends_at: null, ...over });

test("draft wins regardless of dates", () => {
  const pl = priceList({ status: "draft", starts_at: "2020-01-01T00:00:00Z" });
  assert.equal(getPriceListEffectiveState(pl, NOW), "draft");
});

test("scheduled when starts in future", () => {
  const pl = priceList({ starts_at: "2030-01-01T00:00:00Z" });
  assert.equal(getPriceListEffectiveState(pl, NOW), "scheduled");
});

test("expired when ends in past", () => {
  const pl = priceList({ ends_at: "2020-01-01T00:00:00Z" });
  assert.equal(getPriceListEffectiveState(pl, NOW), "expired");
});

test("active when status active and inside window", () => {
  const pl = priceList({ starts_at: "2020-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z" });
  assert.equal(getPriceListEffectiveState(pl, NOW), "active");
});

test("active with no dates at all", () => {
  const pl = priceList();
  assert.equal(getPriceListEffectiveState(pl, NOW), "active");
});

test("matching price requires currency and region", () => {
  const prices = [{ currency_code: "eur", rules: { region_id: "reg_1" } }];
  assert.equal(hasMatchingPrice(prices, { currency_code: "eur", region_id: "reg_1" }), true);
  assert.equal(hasMatchingPrice(prices, { currency_code: "eur", region_id: "reg_2" }), false);
  assert.equal(hasMatchingPrice(prices, { currency_code: "usd", region_id: "reg_1" }), false);
});

test("matching price with no rules matches any region", () => {
  const prices = [{ currency_code: "usd" }];
  assert.equal(hasMatchingPrice(prices, { currency_code: "usd", region_id: "reg_1" }), true);
  assert.equal(hasMatchingPrice(prices, { currency_code: "usd", region_id: "reg_2" }), true);
});

test("audit flags scheduled list", () => {
  const priceLists = [{ id: "plist_1", title: "Summer sale", status: "active", starts_at: "2030-01-01T00:00:00Z", ends_at: null, prices: [] }];
  const regions = [{ id: "reg_1", name: "Europe", currency_code: "eur" }];
  const reports = audit(priceLists, regions, NOW);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, "scheduled");
  assert.notEqual(reports[0].fix, null);
});

test("audit flags currency gap for active list", () => {
  const priceLists = [{
    id: "plist_2", title: "US promo", status: "active",
    starts_at: "2020-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z",
    prices: [{ currency_code: "usd" }],
  }];
  const regions = [{ id: "reg_eu", name: "Europe", currency_code: "eur" }];
  const reports = audit(priceLists, regions, NOW);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, "active-but-no-matching-currency/region-price");
});

test("audit reports nothing when fully covered", () => {
  const priceLists = [{
    id: "plist_3", title: "EU promo", status: "active",
    starts_at: "2020-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z",
    prices: [{ currency_code: "eur", rules: { region_id: "reg_eu" } }],
  }];
  const regions = [{ id: "reg_eu", name: "Europe", currency_code: "eur" }];
  const reports = audit(priceLists, regions, NOW);
  assert.deepEqual(reports, []);
});
