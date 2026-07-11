import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinningPrice, hasRegionAndCurrencyOnlyPair } from "./find-ignored-region-price.js";

const CONTEXT = { region_id: "reg_eu", currency_code: "eur" };

const currencyOnly = (amount = 1000, currency = "eur") => ({
  id: "price_currency_only",
  amount,
  currency_code: currency,
  rules: [],
});

const regionScoped = (amount = 800, region = "reg_eu", currency = "eur") => ({
  id: "price_region",
  amount,
  currency_code: currency,
  rules: [{ attribute: "region_id", value: region }],
});

const regionAndCurrency = (amount = 800, region = "reg_eu", currency = "eur") => ({
  id: "price_region_currency",
  amount,
  currency_code: currency,
  rules: [
    { attribute: "region_id", value: region },
    { attribute: "currency_code", value: currency },
  ],
});

test("region plus currency price outranks currency only", () => {
  const winner = pickWinningPrice([currencyOnly(), regionAndCurrency()], CONTEXT);
  assert.deepEqual(winner, { id: "price_region_currency", amount: 800 });
});

test("region only price still outranks currency only on tie break", () => {
  const winner = pickWinningPrice([currencyOnly(), regionScoped()], CONTEXT);
  assert.deepEqual(winner, { id: "price_region", amount: 800 });
});

test("wrong region rule is excluded", () => {
  const winner = pickWinningPrice([currencyOnly(), regionScoped(800, "reg_us")], CONTEXT);
  assert.deepEqual(winner, { id: "price_currency_only", amount: 1000 });
});

test("wrong currency is excluded even with matching region", () => {
  const winner = pickWinningPrice([regionScoped(800, "reg_eu", "usd")], CONTEXT);
  assert.equal(winner, null);
});

test("no candidates returns null", () => {
  assert.equal(pickWinningPrice([], CONTEXT), null);
});

test("region and currency beats region only when both present", () => {
  const prices = [currencyOnly(), regionScoped(), regionAndCurrency()];
  const winner = pickWinningPrice(prices, CONTEXT);
  assert.deepEqual(winner, { id: "price_region_currency", amount: 800 });
});

test("hasRegionAndCurrencyOnlyPair true when both present", () => {
  const prices = [currencyOnly(), regionScoped()];
  assert.equal(hasRegionAndCurrencyOnlyPair(prices, "reg_eu", "eur"), true);
});

test("hasRegionAndCurrencyOnlyPair false when only one present", () => {
  const prices = [currencyOnly()];
  assert.equal(hasRegionAndCurrencyOnlyPair(prices, "reg_eu", "eur"), false);
});

test("hasRegionAndCurrencyOnlyPair false when wrong region", () => {
  const prices = [currencyOnly(), regionScoped(800, "reg_us")];
  assert.equal(hasRegionAndCurrencyOnlyPair(prices, "reg_eu", "eur"), false);
});
