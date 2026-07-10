/**
 * Find Medusa promotion codes that collide once normalized.
 *
 * Medusa v2 only enforces code uniqueness with a single partial unique index,
 * IDX_unique_promotion_code on code WHERE deleted_at IS NULL. There is no
 * application-level uniqueness check before the insert in
 * createPromotionsWorkflow, so the workflow just relies on Postgres to
 * reject a clash. Because the index is case-sensitive and only looks at
 * non-deleted rows, two promotions created through different paths, the
 * Admin UI, a seed or import script, or a restored backup, can end up with
 * codes that are byte-different but functionally the same, for example
 * SAVE10 vs save10, or SAVE10 with a trailing space. This script never
 * merges or deletes anything. It reports every duplicate group so a human
 * can decide which promotion stays active, and only outside dry run does it
 * deactivate the promotion an operator names by setting status to inactive.
 * Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
// Optional: a promo_ id to deactivate once a human has picked the loser.
const DEACTIVATE_PROMOTION_ID = process.env.DEACTIVATE_PROMOTION_ID || "";

const PROMOTION_FIELDS =
  "id,code,status,is_automatic,campaign_id," +
  "application_method.value,application_method.type,created_at";
const CAMPAIGN_FIELDS = "id,name,starts_at,ends_at";

/**
 * Pure: groups promotions by a normalized code and returns only groups with
 * more than one entry, i.e. two or more distinct promo_ ids that resolve to
 * the same effective code once whitespace and case are ignored. No I/O, no
 * mutation of the input array.
 */
export function findDuplicatePromotionCodes(promotions) {
  const groups = new Map();

  for (const promotion of promotions) {
    const key = promotion.code.trim().toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(promotion);
  }

  const duplicates = new Map();
  for (const [key, entries] of groups) {
    if (entries.length > 1) duplicates.set(key, entries);
  }
  return duplicates;
}

/** Pure: shapes one duplicate group into a human-facing report row. */
export function buildReport(normalizedCode, entries, campaignsById) {
  const rawCodes = [...new Set(entries.map((entry) => entry.code))].sort();
  return {
    normalizedCode,
    isCaseOrWhitespaceVariant: rawCodes.length > 1,
    rawCodes,
    promotions: entries.map((entry) => ({
      id: entry.id,
      code: entry.code,
      status: entry.status,
      campaignId: entry.campaign_id || null,
      applicationMethod: entry.application_method,
      campaignName: (campaignsById.get(entry.campaign_id) || {}).name,
    })),
  };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function* listPromotions(sdk) {
  let offset = 0;
  while (true) {
    const body = await sdk.admin.promotion.list({
      fields: PROMOTION_FIELDS,
      limit: 200,
      offset,
    });
    for (const promotion of body.promotions) yield promotion;
    offset += 200;
    if (offset >= body.count) return;
  }
}

async function getCampaign(sdk, campaignId) {
  if (!campaignId) return null;
  const body = await sdk.admin.campaign.retrieve(campaignId, { fields: CAMPAIGN_FIELDS });
  return body.campaign;
}

async function deactivatePromotion(sdk, promotionId) {
  const body = await sdk.admin.promotion.update(promotionId, { status: "inactive" });
  return body.promotion;
}

export async function run() {
  const sdk = await login();
  const promotions = [];
  for await (const promotion of listPromotions(sdk)) promotions.push(promotion);

  const duplicates = findDuplicatePromotionCodes(promotions);

  const campaignsById = new Map();
  for (const entries of duplicates.values()) {
    for (const entry of entries) {
      const campaignId = entry.campaign_id;
      if (campaignId && !campaignsById.has(campaignId)) {
        campaignsById.set(campaignId, await getCampaign(sdk, campaignId));
      }
    }
  }

  const reports = [];
  for (const [normalizedCode, entries] of duplicates) {
    const report = buildReport(normalizedCode, entries, campaignsById);
    reports.push(report);
    console.warn(
      `Duplicate code ${report.normalizedCode}: ${report.promotions.length} promotion(s) ${JSON.stringify(
        report.promotions.map((p) => p.id)
      )}. Raw codes seen: ${JSON.stringify(report.rawCodes)}`
    );
  }

  if (DEACTIVATE_PROMOTION_ID) {
    console.log(
      `Promotion ${DEACTIVATE_PROMOTION_ID}. ${DRY_RUN ? "would deactivate" : "deactivating"}`
    );
    if (!DRY_RUN) await deactivatePromotion(sdk, DEACTIVATE_PROMOTION_ID);
  }

  console.log(`Done. ${reports.length} duplicate code group(s) found.`);
  return reports;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
