/**
 * Flag Medusa campaigns whose budget.used has already crossed budget.limit.
 *
 * Campaign budgets are only checked when a promotion is computed onto a cart,
 * and used only increments later, when an order completes. This script never
 * reverses a completed order. It reports every over-budget campaign, the
 * promotions riding on it, and the orders that slipped through, and only
 * outside dry run does it deactivate the promotion or close the campaign
 * window so no new cart can pick it up. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/campaign-budget-exceeded-still-applies/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDERS_SINCE = process.env.ORDERS_SINCE || "1970-01-01T00:00:00Z";

const CAMPAIGN_FIELDS = "id,name,campaign_identifier,starts_at,ends_at,*budget";
const PROMOTION_FIELDS = "id,code,status,*application_method,*campaign,*campaign.budget";
const ORDER_FIELDS = "id,display_id,created_at,*promotions,*promotions.campaign,*promotions.campaign.budget";

/**
 * Pure: decides only from limit and used, never mutates anything.
 * limit null/undefined means unlimited. overageAmount is clamped to zero or above.
 */
export function isCampaignOverBudget(budget, pendingAmount) {
  const { limit } = budget;
  const used = budget.used || 0;

  if (limit === null || limit === undefined) {
    return { overBudget: false, wouldExceedIfApplied: false, overageAmount: 0 };
  }

  const overBudget = used >= limit;
  const wouldExceedIfApplied = pendingAmount != null && used + pendingAmount > limit;
  const overageAmount = Math.max(0, used - limit);

  return { overBudget, wouldExceedIfApplied, overageAmount };
}

/** Pure: shapes the finance/support-facing report for one over-budget campaign. */
export function buildReport(campaign, decision, promotions, orders) {
  const budget = campaign.budget || {};
  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    budgetType: budget.type,
    limit: budget.limit,
    used: budget.used,
    overageAmount: decision.overageAmount,
    promotionIds: promotions.map((p) => p.id),
    orderIds: orders.map((o) => o.id),
  };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function* listCampaigns(sdk) {
  let offset = 0;
  while (true) {
    const body = await sdk.admin.campaign.list({ fields: CAMPAIGN_FIELDS, limit: 50, offset });
    for (const campaign of body.campaigns) yield campaign;
    offset += 50;
    if (offset >= body.count) return;
  }
}

async function promotionsForCampaign(sdk, campaignId) {
  const body = await sdk.admin.promotion.list({ campaign_id: campaignId, fields: PROMOTION_FIELDS });
  return body.promotions;
}

async function ordersSince(sdk, campaignId, sinceIso) {
  const body = await sdk.admin.order.list({
    fields: ORDER_FIELDS,
    "promotions.campaign_id": campaignId,
    "created_at[$gte]": sinceIso,
  });
  return body.orders;
}

async function deactivatePromotion(sdk, promotionId) {
  const body = await sdk.admin.promotion.update(promotionId, { status: "inactive" });
  return body.promotion;
}

export async function run() {
  const sdk = await login();
  const reports = [];

  for await (const campaign of listCampaigns(sdk)) {
    const budget = campaign.budget;
    if (!budget) continue;

    const decision = isCampaignOverBudget(budget);
    if (!decision.overBudget) continue;

    const promotions = await promotionsForCampaign(sdk, campaign.id);
    const orders = await ordersSince(sdk, campaign.id, ORDERS_SINCE);
    const report = buildReport(campaign, decision, promotions, orders);
    reports.push(report);

    console.warn(
      `Campaign ${report.campaignId} (${report.campaignName}) over budget: used ${report.used} / limit ${report.limit}, overage ${report.overageAmount}. ${report.promotionIds.length} promo(s), ${report.orderIds.length} order(s).`
    );

    for (const promotion of promotions) {
      if (promotion.status === "inactive") continue;
      console.log(`Promotion ${promotion.id} on campaign ${campaign.id}. ${DRY_RUN ? "would deactivate" : "deactivating"}`);
      if (!DRY_RUN) await deactivatePromotion(sdk, promotion.id);
    }
  }

  console.log(`Done. ${reports.length} campaign(s) over budget.`);
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
