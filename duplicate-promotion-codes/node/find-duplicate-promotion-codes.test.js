import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicatePromotionCodes } from "./find-duplicate-promotion-codes.js";

const promo = (id, code, over = {}) => ({ id, code, status: "active", campaign_id: null, ...over });

test("no duplicates returns an empty map", () => {
  const promotions = [promo("promo_1", "SAVE10"), promo("promo_2", "WELCOME5")];
  assert.equal(findDuplicatePromotionCodes(promotions).size, 0);
});

test("exact duplicate codes are grouped", () => {
  const promotions = [
    promo("promo_1", "SAVE10", { campaign_id: "camp_1" }),
    promo("promo_2", "SAVE10", { campaign_id: "camp_2" }),
  ];
  const result = findDuplicatePromotionCodes(promotions);
  assert.deepEqual([...result.keys()], ["SAVE10"]);
  assert.deepEqual(
    new Set(result.get("SAVE10").map((p) => p.id)),
    new Set(["promo_1", "promo_2"])
  );
});

test("case variant duplicates are grouped", () => {
  const promotions = [promo("promo_1", "SAVE10"), promo("promo_2", "save10")];
  const result = findDuplicatePromotionCodes(promotions);
  assert.deepEqual([...result.keys()], ["SAVE10"]);
  assert.equal(result.get("SAVE10").length, 2);
});

test("whitespace variant duplicates are grouped", () => {
  const promotions = [
    promo("promo_1", "SAVE10"),
    promo("promo_2", "SAVE10 "),
    promo("promo_3", " SAVE10"),
  ];
  const result = findDuplicatePromotionCodes(promotions);
  assert.equal(result.size, 1);
  assert.equal(result.get("SAVE10").length, 3);
});

test("three way collision is a single group", () => {
  const promotions = [
    promo("promo_1", "WELCOME5"),
    promo("promo_2", "welcome5"),
    promo("promo_3", " Welcome5 "),
  ];
  const result = findDuplicatePromotionCodes(promotions);
  assert.equal(result.size, 1);
  assert.equal(result.get("WELCOME5").length, 3);
});

test("unrelated codes never collide", () => {
  const promotions = [promo("promo_1", "SAVE10"), promo("promo_2", "SAVE20")];
  assert.equal(findDuplicatePromotionCodes(promotions).size, 0);
});

test("single promotion never forms a group", () => {
  const promotions = [promo("promo_1", "ONLYONE")];
  assert.equal(findDuplicatePromotionCodes(promotions).size, 0);
});

test("empty input returns an empty map", () => {
  assert.equal(findDuplicatePromotionCodes([]).size, 0);
});

test("mixed duplicates and uniques only reports the duplicate group", () => {
  const promotions = [
    promo("promo_1", "SAVE10"),
    promo("promo_2", "save10"),
    promo("promo_3", "UNIQUE1"),
  ];
  const result = findDuplicatePromotionCodes(promotions);
  assert.deepEqual([...result.keys()], ["SAVE10"]);
  assert.equal(result.has("UNIQUE1"), false);
});
