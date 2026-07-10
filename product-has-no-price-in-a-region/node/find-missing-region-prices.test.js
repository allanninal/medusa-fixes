import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissingRegionPrices } from "./find-missing-region-prices.js";

const variant = (over = {}) => ({
  id: "variant_1",
  sku: "SKU-1",
  prices: [{ currency_code: "usd" }, { currency_code: "gbp" }],
  ...over,
});

const region = (over = {}) => ({
  id: "reg_1",
  name: "United States",
  currency_code: "usd",
  ...over,
});

test("no gaps when all currencies covered", () => {
  const regions = [region(), region({ id: "reg_2", name: "United Kingdom", currency_code: "gbp" })];
  assert.deepEqual(findMissingRegionPrices([variant()], regions), []);
});

test("gap when region currency missing", () => {
  const regions = [region({ id: "reg_3", name: "Eurozone", currency_code: "eur" })];
  const gaps = findMissingRegionPrices([variant()], regions);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].region_name, "Eurozone");
  assert.equal(gaps[0].missing_currency_code, "eur");
  assert.equal(gaps[0].variant_id, "variant_1");
});

test("gap when variant has no prices at all", () => {
  const gaps = findMissingRegionPrices([variant({ prices: [] })], [region()]);
  assert.equal(gaps.length, 1);
});

test("gap when prices key missing entirely", () => {
  const v = { id: "variant_2", sku: "SKU-2" };
  const gaps = findMissingRegionPrices([v], [region()]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].variant_id, "variant_2");
});

test("currency match is case insensitive", () => {
  const regions = [region({ currency_code: "USD" })];
  assert.deepEqual(findMissingRegionPrices([variant()], regions), []);
});

test("multiple variants and regions each checked", () => {
  const variants = [variant(), variant({ id: "variant_2", sku: "SKU-2", prices: [] })];
  const regions = [region(), region({ id: "reg_2", name: "Eurozone", currency_code: "eur" })];
  const gaps = findMissingRegionPrices(variants, regions);
  // variant_1 is missing eur only, variant_2 is missing both usd and eur
  assert.equal(gaps.length, 3);
});

test("empty variants returns no gaps", () => {
  assert.deepEqual(findMissingRegionPrices([], [region()]), []);
});

test("empty regions returns no gaps", () => {
  assert.deepEqual(findMissingRegionPrices([variant()], []), []);
});
