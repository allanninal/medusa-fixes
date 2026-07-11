import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCampaignBudgetUsage, isBuygetBudgetCampaign } from "./reconcile-campaign-budget.js";

const campaign = (over = {}) => ({ id: "camp_1", budget: { type: "usage", limit: 100, used: 0 }, ...over });
const redemption = (over = {}) => ({ orderId: "order_1", promotionId: "promo_1", discountTotal: 10.0, ...over });

test("usage budget counts redemptions", () => {
  const redemptions = [redemption({ orderId: "order_1" }), redemption({ orderId: "order_2" })];
  const result = reconcileCampaignBudgetUsage(campaign(), redemptions);
  assert.equal(result.recomputedUsed, 2);
  assert.equal(result.needsSync, true);
  assert.equal(result.overBudget, false);
});

test("spend budget sums discount totals", () => {
  const c = campaign({ budget: { type: "spend", limit: 100, used: 0 } });
  const redemptions = [redemption({ discountTotal: 30.0 }), redemption({ discountTotal: 45.0 })];
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.recomputedUsed, 75.0);
  assert.equal(result.needsSync, true);
  assert.equal(result.overBudget, false);
});

test("no sync needed when stored matches recomputed", () => {
  const c = campaign({ budget: { type: "usage", limit: 100, used: 2 } });
  const redemptions = [redemption({ orderId: "order_1" }), redemption({ orderId: "order_2" })];
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.needsSync, false);
});

test("over budget when recomputed exceeds limit", () => {
  const c = campaign({ budget: { type: "usage", limit: 2, used: 0 } });
  const redemptions = [0, 1, 2, 3, 4].map((i) => redemption({ orderId: `order_${i}` }));
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.recomputedUsed, 5);
  assert.equal(result.overBudget, true);
});

test("exactly at limit is not over budget", () => {
  const c = campaign({ budget: { type: "usage", limit: 3, used: 0 } });
  const redemptions = [0, 1, 2].map((i) => redemption({ orderId: `order_${i}` }));
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.overBudget, false);
});

test("zero limit means unlimited, never over budget", () => {
  const c = campaign({ budget: { type: "usage", limit: 0, used: 0 } });
  const redemptions = Array.from({ length: 50 }, (_, i) => redemption({ orderId: `order_${i}` }));
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.overBudget, false);
});

test("no redemptions recomputes to zero", () => {
  const result = reconcileCampaignBudgetUsage(campaign(), []);
  assert.equal(result.recomputedUsed, 0);
  assert.equal(result.needsSync, false);
});

test("spend budget over limit from summed adjustments", () => {
  const c = campaign({ budget: { type: "spend", limit: 50.0, used: 0 } });
  const redemptions = [redemption({ discountTotal: 20.0 }), redemption({ discountTotal: 40.0 })];
  const result = reconcileCampaignBudgetUsage(c, redemptions);
  assert.equal(result.recomputedUsed, 60.0);
  assert.equal(result.overBudget, true);
});

test("isBuygetBudgetCampaign requires limit and buyget type", () => {
  const c = { budget: { limit: 50, used: 0 }, promotions: [{ id: "promo_1", type: "buyget" }] };
  assert.equal(isBuygetBudgetCampaign(c), true);
});

test("isBuygetBudgetCampaign false without limit", () => {
  const c = { budget: { limit: 0, used: 0 }, promotions: [{ id: "promo_1", type: "buyget" }] };
  assert.equal(isBuygetBudgetCampaign(c), false);
});

test("isBuygetBudgetCampaign false without buyget promotion", () => {
  const c = { budget: { limit: 50, used: 0 }, promotions: [{ id: "promo_1", type: "standard" }] };
  assert.equal(isBuygetBudgetCampaign(c), false);
});
