/**
 * Find Medusa v2 variants where an active price list is wrongly suppressing
 * the default variant price.
 *
 * Medusa's pricing module resolves calculated_price by first checking
 * whether any price list price matches the given context. Once a matching
 * price list price set exists at all, the price-selection strategy never
 * falls back to compare against the variant's default price, even when the
 * price list rules do not match the current shopper or the default is
 * actually cheaper. This is a known core bug (medusajs/medusa#10613). This
 * script only reports affected variants. It never edits or deactivates a
 * price list on its own.
 *
 * Guide: https://www.allanninal.dev/medusa/price-list-suppresses-default-price/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const REGION_ID = process.env.MEDUSA_REGION_ID || "";
const CURRENCY_CODE = process.env.MEDUSA_CURRENCY_CODE || "usd";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRICE_LIST_FIELDS = "id,title,status,rules,starts_at,ends_at,prices.amount,prices.currency_code,prices.price_list_id";
const PRODUCT_FIELDS = "id,*variants,variants.prices.amount,variants.prices.currency_code,variants.prices.price_list_id";

// Pure. priceListRules is a plain object of ruleKey -> [allowed values].
// requestContext carries customerGroupIds among other fields.
export function rulesMatch(priceListRules, requestContext) {
  for (const [ruleKey, allowedValues] of Object.entries(priceListRules || {})) {
    if (ruleKey === "customer_group_id") {
      const requested = new Set(requestContext.customerGroupIds || []);
      if (!allowedValues.some((v) => requested.has(v))) return false;
    }
  }
  return true;
}

/**
 * Pure decision logic. No I/O. input has:
 *   calculatedAmount, isCalculatedPriceFromPriceList, priceListRules,
 *   requestContext, defaultAmountForCurrency.
 * Returns { suppressed, reason } where reason is one of
 * "none" | "rules_mismatch" | "higher_than_default".
 */
export function isDefaultPriceWronglySuppressed(input) {
  const { calculatedAmount, isCalculatedPriceFromPriceList, priceListRules, requestContext, defaultAmountForCurrency } = input;

  if (!isCalculatedPriceFromPriceList) return { suppressed: false, reason: "none" };
  if (defaultAmountForCurrency == null) return { suppressed: false, reason: "none" };

  if (!rulesMatch(priceListRules, requestContext)) {
    return { suppressed: true, reason: "rules_mismatch" };
  }

  if (calculatedAmount > defaultAmountForCurrency) {
    return { suppressed: true, reason: "higher_than_default" };
  }

  return { suppressed: false, reason: "none" };
}

async function login() {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  return (await res.json()).token;
}

async function activePriceLists(token) {
  let offset = 0;
  const out = [];
  while (true) {
    const res = await fetch(
      `${BASE}/admin/price-lists?status[]=active&fields=${encodeURIComponent(PRICE_LIST_FIELDS)}&offset=${offset}&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    out.push(...body.price_lists);
    offset += body.limit;
    if (offset >= body.count) return out;
  }
}

async function priceListProducts(token, priceListId) {
  const res = await fetch(
    `${BASE}/admin/price-lists/${priceListId}/products?fields=${encodeURIComponent(PRODUCT_FIELDS)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).products;
}

async function calculatedPriceForProduct(token, productId, regionId, currencyCode) {
  const res = await fetch(
    `${BASE}/admin/products/${productId}?fields=${encodeURIComponent("id,*variants.calculated_price")}&region_id=${regionId}&currency_code=${currencyCode}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return (await res.json()).product.variants;
}

function defaultAmountForCurrency(variant, currencyCode) {
  for (const price of variant.prices || []) {
    if (price.currency_code === currencyCode && !price.price_list_id) return price.amount;
  }
  return null;
}

function reportLine(priceListId, variantId, currencyCode, decision, calculatedAmount, defaultAmount) {
  return `price_list=${priceListId} variant=${variantId} currency=${currencyCode} ` +
    `reason=${decision.reason} calculated=${calculatedAmount} default=${defaultAmount}`;
}

export async function run() {
  const token = await login();
  const requestContext = { regionId: REGION_ID, currencyCode: CURRENCY_CODE, customerGroupIds: [] };
  let flagged = 0;

  for (const priceList of await activePriceLists(token)) {
    const rules = priceList.rules || {};
    for (const product of await priceListProducts(token, priceList.id)) {
      const calcVariants = new Map(
        (await calculatedPriceForProduct(token, product.id, REGION_ID, CURRENCY_CODE)).map((v) => [v.id, v])
      );

      for (const variant of product.variants || []) {
        const calc = (calcVariants.get(variant.id) || {}).calculated_price || {};
        const defaultAmount = defaultAmountForCurrency(variant, CURRENCY_CODE);

        const decision = isDefaultPriceWronglySuppressed({
          calculatedAmount: calc.calculated_amount,
          isCalculatedPriceFromPriceList: Boolean(calc.is_calculated_price_price_list),
          priceListRules: rules,
          requestContext,
          defaultAmountForCurrency: defaultAmount,
        });

        if (!decision.suppressed) continue;

        console.warn(reportLine(priceList.id, variant.id, CURRENCY_CODE, decision, calc.calculated_amount, defaultAmount));
        flagged++;
      }
    }
  }

  console.log(`Done. ${flagged} variant/price list combination(s) flagged for review. Dry run: ${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
