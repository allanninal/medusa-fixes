/**
 * Flag Medusa variants whose shown price currency disagrees with the region's currency_code.
 *
 * A Region has exactly one currency_code, but the price a customer sees comes from a
 * separate Pricing Module record: a price row on a price_set linked to the variant.
 * calculated_price resolves the region's currency_code and filters the price set for a
 * matching row. If the region's currency changed after prices were seeded, if a price
 * list scoped to another currency is still active, or if no price exists for the
 * region's real currency, the resolver falls through to a different currency and the
 * storefront renders it under the region's symbol. This never auto-converts an amount.
 * It only ever writes a price row in the one confirmed, unambiguous case: a variant is
 * missing a row for the region's currency and a human already verified the amount.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/wrong-currency-shown-for-a-region/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Optional, human-confirmed amounts for the narrow missing_currency_row repair case.
// Format: "variant_id:currency_code:amount,variant_id:currency_code:amount"
function parseConfirmedAmounts(raw) {
  const map = new Map();
  for (const entry of (raw || "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [variantId, currencyCode, amount] = trimmed.split(":");
    map.set(`${variantId}:${currencyCode.toLowerCase()}`, Number(amount));
  }
  return map;
}

const CONFIRMED_AMOUNTS = parseConfirmedAmounts(process.env.CONFIRMED_AMOUNTS);

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, currency_code: string }} region
 * @param {Array<{ variant_id: string, product_id: string,
 *   prices: Array<{ id: string, currency_code: string, amount: number, price_list_id?: string|null }>,
 *   calculated_price?: { currency_code: string, price_list_id?: string|null } | null }>} variantPrices
 * @returns {Array<{ product_id: string, variant_id: string, region_id: string,
 *   expected_currency: string, shown_currency: string, price_id?: string,
 *   price_list_id?: string|null, reason: "calculated_mismatch"|"missing_currency_row" }>}
 *
 * reason is "calculated_mismatch" when the price the storefront actually resolved
 * does not match the region's currency, or "missing_currency_row" when no raw price
 * row exists for the region's currency at all (referencing the nearest matched
 * price's id/price_list_id, if any row exists).
 */
export function findCurrencyMismatches(region, variantPrices) {
  const findings = [];
  for (const vp of variantPrices) {
    const calculated = vp.calculated_price;
    if (calculated && calculated.currency_code !== region.currency_code) {
      findings.push({
        product_id: vp.product_id,
        variant_id: vp.variant_id,
        region_id: region.id,
        expected_currency: region.currency_code,
        shown_currency: calculated.currency_code,
        price_id: undefined,
        price_list_id: calculated.price_list_id,
        reason: "calculated_mismatch",
      });
      continue;
    }

    const rows = vp.prices || [];
    const matchingRow = rows.find((p) => p.currency_code === region.currency_code);
    if (!matchingRow) {
      const nearest = rows[0] || {};
      findings.push({
        product_id: vp.product_id,
        variant_id: vp.variant_id,
        region_id: region.id,
        expected_currency: region.currency_code,
        shown_currency: nearest.currency_code,
        price_id: nearest.id,
        price_list_id: nearest.price_list_id,
        reason: "missing_currency_row",
      });
    }
  }
  return findings;
}

async function getAdminToken() {
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function adminGet(token, path, params = {}) {
  const url = new URL(`${BACKEND_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status} on GET ${path}`);
  return res.json();
}

async function adminPost(token, path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST ${path}`);
  return res.json();
}

async function listRegions(token) {
  const regions = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/regions", {
      fields: "id,name,currency_code,*countries",
      limit,
      offset,
    });
    regions.push(...data.regions);
    offset += limit;
    if (offset >= data.count) return regions;
  }
}

async function listVariantPricesForRegion(token, regionId) {
  const variantPrices = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const data = await adminGet(token, "/admin/products", {
      region_id: regionId,
      fields: "id,title,*variants,*variants.calculated_price,*variants.prices",
      limit,
      offset,
    });
    for (const product of data.products) {
      for (const variant of product.variants || []) {
        variantPrices.push({
          variant_id: variant.id,
          product_id: product.id,
          prices: variant.prices || [],
          calculated_price: variant.calculated_price,
        });
      }
    }
    offset += limit;
    if (offset >= data.count) return variantPrices;
  }
}

async function listActivePriceLists(token) {
  const data = await adminGet(token, "/admin/price-lists", {
    "status[]": "active",
    fields: "id,title,status,*prices,*rules",
    limit: 100,
  });
  return data.price_lists;
}

async function addConfirmedPriceRow(token, variantId, currencyCode, amount) {
  return adminPost(token, `/admin/products/variants/${variantId}/prices`, {
    prices: [{ currency_code: currencyCode, amount }],
  });
}

export async function run() {
  const token = await getAdminToken();
  const regions = await listRegions(token);

  let totalFindings = 0;
  let totalRepaired = 0;
  for (const region of regions) {
    const regionRef = { id: region.id, currency_code: region.currency_code };
    const variantPrices = await listVariantPricesForRegion(token, region.id);
    const findings = findCurrencyMismatches(regionRef, variantPrices);

    for (const finding of findings) {
      totalFindings++;
      console.warn(
        `Region ${region.id} (${region.currency_code}): variant ${finding.variant_id} expected=${finding.expected_currency} shown=${finding.shown_currency} reason=${finding.reason} price_list_id=${finding.price_list_id}`
      );

      if (finding.reason !== "missing_currency_row") {
        // calculated_mismatch, or any real FX discrepancy, is always a flagged
        // report for the merchant, never auto-repaired.
        continue;
      }

      const key = `${finding.variant_id}:${finding.expected_currency.toLowerCase()}`;
      const confirmedAmount = CONFIRMED_AMOUNTS.get(key);
      if (confirmedAmount === undefined) {
        console.log(`  No confirmed amount for ${finding.variant_id} in ${finding.expected_currency}. Flagged only, not repaired.`);
        continue;
      }

      console.log(
        `  ${DRY_RUN ? "Would call" : "Calling"} POST /admin/products/variants/${finding.variant_id}/prices {"currency_code": "${finding.expected_currency}", "amount": ${confirmedAmount}}`
      );
      if (!DRY_RUN) {
        await addConfirmedPriceRow(token, finding.variant_id, finding.expected_currency, confirmedAmount);
      }
      totalRepaired++;
    }
  }

  console.log(`Done. ${totalFindings} mismatch(es) flagged, ${totalRepaired} ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
