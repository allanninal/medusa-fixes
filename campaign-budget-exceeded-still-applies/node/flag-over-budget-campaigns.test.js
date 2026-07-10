import { test } from "node:test";
import assert from "node:assert/strict";
import { isCampaignOverBudget, buildReport } from "./flag-over-budget-campaigns.js";

test("unlimited budget is never over", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: null, used: 999999 });
  assert.deepEqual(result, { overBudget: false, wouldExceedIfApplied: false, overageAmount: 0 });
});

test("used under limit is not over budget", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 4000 });
  assert.equal(result.overBudget, false);
  assert.equal(result.overageAmount, 0);
});

test("used equal to limit counts as over budget", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 5000 });
  assert.equal(result.overBudget, true);
  assert.equal(result.overageAmount, 0);
});

test("used past limit reports overage amount", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 6600 });
  assert.equal(result.overBudget, true);
  assert.equal(result.overageAmount, 1600);
});

test("usage type limit zero is immediately over", () => {
  const result = isCampaignOverBudget({ type: "usage", limit: 0, used: 0 });
  assert.equal(result.overBudget, true);
  assert.equal(result.overageAmount, 0);
});

test("would exceed if applied true when pending amount pushes past limit", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 4800 }, 500);
  assert.equal(result.overBudget, false);
  assert.equal(result.wouldExceedIfApplied, true);
});

test("would exceed if applied false when pending amount still fits", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 4800 }, 100);
  assert.equal(result.wouldExceedIfApplied, false);
});

test("no pending amount never sets would exceed if applied", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: 4800 });
  assert.equal(result.wouldExceedIfApplied, false);
});

test("negative used from a race condition is not over budget", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 5000, used: -200 });
  assert.equal(result.overBudget, false);
  assert.equal(result.overageAmount, 0);
});

test("missing used key defaults to zero", () => {
  const result = isCampaignOverBudget({ type: "spend", limit: 100 });
  assert.equal(result.overBudget, false);
  assert.equal(result.overageAmount, 0);
});

test("buildReport shapes expected fields", () => {
  const campaign = { id: "camp_1", name: "Summer sale", budget: { type: "spend", limit: 5000, used: 6600 } };
  const decision = isCampaignOverBudget(campaign.budget);
  const promotions = [{ id: "promo_1" }, { id: "promo_2" }];
  const orders = [{ id: "order_1" }];
  const report = buildReport(campaign, decision, promotions, orders);
  assert.equal(report.campaignId, "camp_1");
  assert.equal(report.overageAmount, 1600);
  assert.deepEqual(report.promotionIds, ["promo_1", "promo_2"]);
  assert.deepEqual(report.orderIds, ["order_1"]);
});
