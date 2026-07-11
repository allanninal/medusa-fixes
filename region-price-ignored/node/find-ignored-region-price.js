/**
 * Find Medusa v2 variants where a region scoped price is being ignored in
 * favor of a plain currency only price.
 *
 * The Pricing Module's calculated_price resolver first looks for a price
 * whose rule set is an exact, complete match for the request context. When
 * nothing matches every rule at once it falls back to the price matching
 * the most rules, and ties or partial matches resolve toward the plain
 * currency only row instead of the region scoped one (medusajs/medusa#13120).
 * The data is stored correctly, so this script only reports. It never
 * rewrites a price.
 *
 * Guide: https://www.allanninal.dev/medusa/region-price-ignored/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const PRODUCT_FIELDS = [
  "id,title,*variants",
  "variants.prices.id,variants.prices.amount,variants.prices.currency_code",
  "variants.prices.rules_count",
  "variants.prices.price_rules.attribute,variants.prices.price_rules.value",
].join(",");

function ruleSatisfied(rule, context) {
  if (rule.attribute === "region_id") return rule.value === context.region_id;
  if (rule.attribute === "currency_code") return rule.value === context.currency_code;
  return false;
}

export function pickWinningPrice(prices, context) {
  // Pure: no I/O. prices: [{id, amount, currency_code, rules}]. context: {region_id, currency_code}.
  //
  // Decision: (1) filter to prices whose every rule is satisfied by context
  // and whose currency_code matches context; (2) among survivors, rank by
  // number of matched rules, then by total rule count (more specific wins
  // ties), then prefer rows that explicitly carry a region_id rule; (3)
  // return the top candidate or null. This is the exact branch to
  // reproduce issue #13120 against: a region+currency price must outrank a
  // currency-only price for the same currency_code and matching region_id.
  const candidates = prices.filter(
    (p) =>
      p.currency_code === context.currency_code &&
      (p.rules || []).every((r) => ruleSatisfied(r, context))
  );
  if (!candidates.length) return null;

  const sortKey = (p) => {
    const rules = p.rules || [];
    const matched = rules.filter((r) => ruleSatisfied(r, context)).length;
    const hasRegionRule = rules.some((r) => r.attribute === "region_id");
    return [matched, rules.length, hasRegionRule ? 1 : 0];
  };

  const winner = candidates.reduce((best, p) => {
    const a = sortKey(p);
    const b = sortKey(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? p : best;
    }
    return best;
  }, candidates[0]);

  return { id: winner.id, amount: winner.amount };
}

export function hasRegionAndCurrencyOnlyPair(prices, regionId, currencyCode) {
  // Pure. True when the variant has both a region scoped row for this
  // region/currency and a plain currency-only row in the same currency.
  const hasRegionRow = prices.some(
    (p) =>
      p.currency_code === currencyCode &&
      p.rules.some((r) => r.attribute === "region_id" && r.value === regionId)
  );
  const hasCurrencyOnlyRow = prices.some((p) => p.currency_code === currencyCode && p.rules.length === 0);
  return hasRegionRow && hasCurrencyOnlyRow;
}

async function login() {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listRegions(token) {
  const url = new URL(`${BASE}/admin/regions`);
  url.searchParams.set("fields", "id,name,currency_code,countries.iso_2");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa regions ${res.status}`);
  const body = await res.json();
  return body.regions;
}

async function* iterProducts(token) {
  let offset = 0;
  while (true) {
    const url = new URL(`${BASE}/admin/products`);
    url.searchParams.set("fields", PRODUCT_FIELDS);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "50");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Medusa products ${res.status}`);
    const body = await res.json();
    for (const product of body.products) yield product;
    offset += body.limit;
    if (offset >= body.count) return;
  }
}

async function servedCalculatedPrice(publishableKey, productId, regionId) {
  const url = new URL(`${BASE}/store/products/${productId}`);
  url.searchParams.set("region_id", regionId);
  url.searchParams.set("fields", "*variants.calculated_price");
  const res = await fetch(url, { headers: { "x-publishable-api-key": publishableKey } });
  if (!res.ok) throw new Error(`Medusa store product ${res.status}`);
  const body = await res.json();
  return body.product.variants;
}

function variantPriceDicts(variant) {
  return (variant.prices || []).map((price) => ({
    id: price.id,
    amount: price.amount,
    currency_code: price.currency_code,
    rules: (price.price_rules || []).map((rule) => ({ attribute: rule.attribute, value: rule.value })),
  }));
}

export async function run() {
  if (!PUBLISHABLE_KEY) {
    console.warn("MEDUSA_PUBLISHABLE_KEY is not set. Skipping the Store API cross-check.");
  }

  const token = await login();
  const regions = await listRegions(token);
  let flagged = 0;

  for await (const product of iterProducts(token)) {
    for (const variant of product.variants || []) {
      const prices = variantPriceDicts(variant);

      for (const region of regions) {
        const regionId = region.id;
        const currencyCode = region.currency_code;

        if (!hasRegionAndCurrencyOnlyPair(prices, regionId, currencyCode)) continue;

        const context = { region_id: regionId, currency_code: currencyCode };
        const expected = pickWinningPrice(prices, context);
        if (!expected) continue;

        let served = null;
        if (PUBLISHABLE_KEY) {
          const servedVariants = await servedCalculatedPrice(PUBLISHABLE_KEY, product.id, regionId);
          const servedVariant = servedVariants.find((v) => v.id === variant.id) || {};
          served = servedVariant.calculated_price || null;
        }

        const servedId = served ? served.id : null;
        const servedAmount = served ? served.calculated_amount : null;

        if (servedId !== null && servedId === expected.id) continue;

        console.warn(
          `variant=${variant.id} region=${regionId} currency=${currencyCode} ` +
          `expected_price_id=${expected.id} expected_amount=${expected.amount} ` +
          `served_price_id=${servedId} served_amount=${servedAmount}`
        );
        flagged++;
      }
    }
  }

  console.log(`Done. ${flagged} variant/region pair(s) flagged for review. Dry run: ${DRY_RUN}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
