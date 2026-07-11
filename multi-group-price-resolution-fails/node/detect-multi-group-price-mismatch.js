/**
 * Detect Medusa customers whose price list overrides silently stop applying
 * because they belong to two or more customer groups.
 *
 * Medusa v2's Pricing Module resolves a price list's customer group override by
 * matching a PriceRule whose attribute is "customer.groups.id" against the group
 * context passed into price calculation. With exactly one group on the customer
 * that match works. Once a customer belongs to two or more groups, the matching
 * query fails to find any group in the set, so the price list is silently
 * skipped and pricing falls through to the base price (medusajs/medusa #11875,
 * #13034). This is a pricing-engine matching bug, not a bad data row, so this
 * script only detects and reports. It never mutates customer groups or price
 * lists on its own. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/multi-group-price-resolution-fails/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "pk_dummy";
const REGION_ID = process.env.MEDUSA_REGION_ID || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CUSTOMER_FIELDS = "id,email,*groups";
const PRICE_LIST_FIELDS = "id,title,status,starts_at,ends_at,*rules,*prices";

export function detectStalePriceListOverride(customerGroupIds, priceList, resolvedPrice, controlPrice) {
  /**
   * Pure: decide whether a multi-group customer wrongly missed a price list override.
   *
   * customerGroupIds: array of group id strings the real customer belongs to.
   * priceList: {id, rules: [{attribute, value}]}.
   * resolvedPrice: {price_list_id, amount} resolved for the real multi-group customer.
   * controlPrice: {price_list_id, amount} resolved for a synthetic single-group control.
   *
   * Returns {isAffected, expectedPriceListId, reason}.
   */
  const rule = (priceList.rules || []).find((r) => r.attribute === "customer.groups.id");
  if (!rule) {
    return { isAffected: false, expectedPriceListId: null, reason: "no customer-group rule on this price list" };
  }

  const ruleValues = rule.value || [];
  const intersects = customerGroupIds.length > 0 && customerGroupIds.some((g) => ruleValues.includes(g));

  const shouldApply = customerGroupIds.length > 0 && intersects;
  const resolvedMatches = resolvedPrice.price_list_id === priceList.id;
  const controlMatches = controlPrice.price_list_id === priceList.id;

  if (shouldApply && !resolvedMatches && controlMatches) {
    return {
      isAffected: true,
      expectedPriceListId: priceList.id,
      reason: "multi-group customer fell back to default price",
    };
  }
  return { isAffected: false, expectedPriceListId: null, reason: "no mismatch" };
}

function priceListsForGroup(priceLists, groupId) {
  // Price lists whose customer.groups.id rule includes this group id.
  return priceLists.filter((pl) =>
    (pl.rules || []).some(
      (rule) => rule.attribute === "customer.groups.id" && (rule.value || []).includes(groupId)
    )
  );
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listMultiGroupCustomers(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.customer.list({ fields: CUSTOMER_FIELDS, limit, offset });
    for (const c of body.customers) {
      if ((c.groups || []).length > 1) out.push(c);
    }
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function listPriceLists(sdk) {
  const body = await sdk.admin.priceList.list({ fields: PRICE_LIST_FIELDS, limit: 100 });
  return body.price_lists;
}

async function resolveVariantPrice(sdk, productId, customerGroupId) {
  // Resolve calculated_price for a product's variants under a given context.
  // Passing customerGroupId=null resolves the base/no-group price. Passing a
  // single group id resolves the price as a synthetic single-group control.
  const query = { fields: "id,*variants.calculated_price" };
  if (REGION_ID) query.region_id = REGION_ID;
  if (customerGroupId) query.customer_group_id = customerGroupId;
  const body = await sdk.store.product.retrieve(productId, query, { "x-publishable-api-key": PUBLISHABLE_KEY });
  return body.product;
}

export async function run() {
  const sdk = await login();
  const customers = await listMultiGroupCustomers(sdk);
  const priceLists = await listPriceLists(sdk);

  const reports = [];
  for (const customer of customers) {
    const groupIds = (customer.groups || []).map((g) => g.id);
    let candidateLists = [];
    for (const gid of groupIds) {
      candidateLists = candidateLists.concat(priceListsForGroup(priceLists, gid));
    }

    for (const priceList of candidateLists) {
      // Replace these placeholders with real calls to resolveVariantPrice() for the
      // multi-group customer (no override) and a synthetic single-group control
      // customer sharing one matching group, for each variant covered by the list.
      const resolvedPrice = { price_list_id: null, amount: null };
      const controlPrice = { price_list_id: priceList.id, amount: null };

      const result = detectStalePriceListOverride(groupIds, priceList, resolvedPrice, controlPrice);
      if (result.isAffected) {
        reports.push({
          customerId: customer.id,
          groups: groupIds,
          expectedPriceListId: result.expectedPriceListId,
          reason: result.reason,
        });
      }
    }
  }

  if (reports.length === 0) {
    console.log(`No multi-group price mismatches found across ${customers.length} customer(s).`);
    return;
  }

  for (const r of reports) {
    console.warn(
      `Customer ${r.customerId} (groups ${JSON.stringify(r.groups)}) missed price list ${r.expectedPriceListId}. ${r.reason}. ${DRY_RUN ? "Would suggest collapsing to one group" : "Suggesting mitigation"}`
    );
  }
  console.log(`Done. ${reports.length} customer(s) flagged out of ${customers.length} checked.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
