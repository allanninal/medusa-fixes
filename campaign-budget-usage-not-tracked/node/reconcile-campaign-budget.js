/**
 * Reconcile a Medusa campaign's budget.used against real order redemptions.
 *
 * Buy X Get Y (buyget) promotions do not reliably emit or persist the usage-update
 * action that keeps a campaign's budget.used current, so a campaign tied only to a
 * buyget promotion can be redeemed past its limit while its dashboard still shows an
 * untouched budget. This recomputes real usage from orders and reports every campaign
 * where the recomputed number disagrees with what is stored, or has crossed the limit.
 * By default it only reports. It syncs budget.used only when DRY_RUN=false, and it
 * never deactivates a promotion on its own even then. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/campaign-budget-usage-not-tracked/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CAMPAIGN_FIELDS = "id,name,campaign_identifier,starts_at,ends_at,*budget,*promotions";
const ORDER_FIELDS = "id,display_id,total,created_at,*promotions,*items,*items.adjustments";

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listCampaigns(token) {
  const url = new URL(`${BASE_URL}/admin/campaigns`);
  url.searchParams.set("fields", CAMPAIGN_FIELDS);
  url.searchParams.set("limit", "200");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.campaigns;
}

export function isBuygetBudgetCampaign(campaign) {
  const budget = campaign.budget || {};
  if (!budget.limit) return false;
  const promotions = campaign.promotions || [];
  return promotions.some((p) => p.type === "buyget");
}

async function ordersRedeeming(token, promotionIds) {
  const url = new URL(`${BASE_URL}/admin/orders`);
  url.searchParams.set("fields", ORDER_FIELDS);
  url.searchParams.set("limit", "200");
  for (const id of promotionIds) url.searchParams.append("promotion_id[]", id);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.orders;
}

export function redemptionsForCampaign(orders, promotionIds) {
  // Turn raw orders into flat redemption rows the pure reconciler can use.
  const ids = new Set(promotionIds);
  const rows = [];
  for (const order of orders) {
    const matched = (order.promotions || []).filter((p) => ids.has(p.id)).map((p) => p.id);
    if (matched.length === 0) continue;
    let discountTotal = 0;
    for (const item of order.items || []) {
      for (const adj of item.adjustments || []) {
        if (ids.has(adj.promotion_id)) discountTotal += Number(adj.amount || 0);
      }
    }
    rows.push({ orderId: order.id, promotionId: matched[0], discountTotal });
  }
  return rows;
}

/**
 * Pure: recomputes usage from redemptions and compares it to the stored budget.
 * campaign = { id, budget: { type: "spend" | "usage", limit, used } }
 * redemptions = [{ orderId, promotionId, discountTotal }, ...]
 * No I/O. Only arithmetic and comparison, so it can be unit tested against
 * fabricated redemption arrays and budget states.
 */
export function reconcileCampaignBudgetUsage(campaign, redemptions) {
  const { budget } = campaign;
  const recomputedUsed =
    budget.type === "usage"
      ? redemptions.length
      : redemptions.reduce((sum, r) => sum + r.discountTotal, 0);

  const { limit, used: storedUsed } = budget;
  const needsSync = recomputedUsed !== storedUsed;
  const overBudget = limit > 0 && recomputedUsed > limit;

  return {
    campaignId: campaign.id,
    storedUsed,
    recomputedUsed,
    limit,
    needsSync,
    overBudget,
  };
}

async function syncBudgetUsed(token, campaignId, recomputedUsed) {
  const res = await fetch(`${BASE_URL}/admin/campaigns/${campaignId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ budget: { used: recomputedUsed } }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.campaign;
}

export async function run() {
  const token = await getToken();
  const campaigns = (await listCampaigns(token)).filter(isBuygetBudgetCampaign);

  if (campaigns.length === 0) {
    console.log("No campaigns found with a budget tied to a buyget promotion.");
    return;
  }

  for (const campaign of campaigns) {
    const promotionIds = campaign.promotions.filter((p) => p.type === "buyget").map((p) => p.id);
    const orders = await ordersRedeeming(token, promotionIds);
    const redemptions = redemptionsForCampaign(orders, promotionIds);
    const result = reconcileCampaignBudgetUsage(campaign, redemptions);

    console.log(
      `campaign_id=${result.campaignId} identifier=${campaign.campaign_identifier} ` +
      `budget_type=${campaign.budget.type} stored_used=${result.storedUsed} ` +
      `recomputed_used=${result.recomputedUsed} limit=${result.limit} over_budget=${result.overBudget}`
    );

    if (result.needsSync) {
      if (DRY_RUN) {
        console.log(`Would sync budget.used to ${result.recomputedUsed} for campaign ${result.campaignId}.`);
      } else {
        await syncBudgetUsed(token, result.campaignId, result.recomputedUsed);
        console.log(`Synced budget.used to ${result.recomputedUsed} for campaign ${result.campaignId}.`);
      }
    }

    if (result.overBudget) {
      console.warn(
        `Campaign ${result.campaignId} is over budget. Suggested review action (not automatic): ` +
        `PATCH /admin/promotions/${promotionIds[0]} {"status": "inactive"}`
      );
    }
  }

  console.log(`Done. ${campaigns.length} buyget-budget campaign(s) checked.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
