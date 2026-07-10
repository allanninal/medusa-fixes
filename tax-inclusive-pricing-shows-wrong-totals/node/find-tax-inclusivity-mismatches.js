/**
 * Flag Medusa contexts where tax-inclusive pricing settings disagree.
 *
 * Whether a price is tax-inclusive is not one global flag in Medusa v2. It is
 * decided per calculation context by a PricePreference keyed on region_id or
 * currency_code, and the same includes_tax concept is set again independently on
 * Region, Currency, PriceList, and ShippingOption. Because those settings are
 * configured in different admin screens, they can drift out of sync, so
 * calculatePrices resolves is_calculated_price_tax_inclusive inconsistently
 * across line items and the cart totals engine stops reconciling: subtotal plus
 * tax_total no longer equals total. This never rewrites an order's totals or a
 * price amount. It only ever writes the specific PricePreference a human has
 * approved. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/tax-inclusive-pricing-shows-wrong-totals/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ROUNDING_TOLERANCE = 0.02;

// Optional, human-approved fix for exactly one context.
// Format: "region_id|currency_code:value:true|false"
function parseApplyFixFor(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const [attribute, value, flag] = trimmed.split(":");
  return { attribute, value, is_tax_inclusive: flag.toLowerCase() === "true" };
}

const APPLY_FIX_FOR = parseApplyFixFor(process.env.APPLY_FIX_FOR);

/**
 * Pure decision function. No I/O.
 *
 * @param {Array<{ attribute: "region_id"|"currency_code", value: string, is_tax_inclusive: boolean }>} preferences
 * @param {Array<{ source_type: "price_list"|"shipping_option", source_id: string,
 *   region_id?: string, currency_code?: string }>} priceContexts
 * @returns {Array<{ source_type: string, source_id: string, region_id?: string,
 *   currency_code?: string, region_pref?: boolean, currency_pref?: boolean, reason: string }>}
 */
export function findTaxInclusivityMismatches(preferences, priceContexts) {
  const regionPrefMap = new Map();
  const currencyPrefMap = new Map();
  for (const pref of preferences) {
    if (pref.attribute === "region_id") regionPrefMap.set(pref.value, pref.is_tax_inclusive);
    else if (pref.attribute === "currency_code") currencyPrefMap.set(pref.value, pref.is_tax_inclusive);
  }

  const mismatches = [];
  for (const ctx of priceContexts) {
    const regionPref = regionPrefMap.get(ctx.region_id);
    const currencyPref = currencyPrefMap.get(ctx.currency_code);

    let reason;
    if (regionPref !== undefined && currencyPref !== undefined && regionPref !== currencyPref) {
      reason = "region/currency preference conflict";
    } else if (regionPref === undefined && currencyPref === undefined) {
      reason = "no preference configured, defaults may drift";
    } else {
      continue;
    }

    mismatches.push({
      source_type: ctx.source_type,
      source_id: ctx.source_id,
      region_id: ctx.region_id,
      currency_code: ctx.currency_code,
      region_pref: regionPref,
      currency_pref: currencyPref,
      reason,
    });
  }
  return mismatches;
}

function ruleValue(price, key) {
  for (const rule of price.price_rules || []) {
    if (rule.attribute === key) return rule.value;
  }
  return price[key];
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function listRegions(sdk) {
  const regions = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { regions: page, count } = await sdk.admin.region.list({
      fields: "id,name,currency_code,automatic_taxes",
      limit,
      offset,
    });
    regions.push(...page);
    offset += limit;
    if (offset >= count) return regions;
  }
}

async function listPricePreferences(sdk) {
  const preferences = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const { price_preferences: page, count } = await sdk.admin.pricePreference.list({
      fields: "id,attribute,value,is_tax_inclusive",
      limit,
      offset,
    });
    preferences.push(...page);
    offset += limit;
    if (offset >= count) return preferences;
  }
}

async function priceListsAsContexts(sdk) {
  const { price_lists } = await sdk.admin.priceList.list({
    fields: "id,title,status,*prices",
    limit: 100,
  });
  const contexts = [];
  for (const priceList of price_lists) {
    for (const price of priceList.prices || []) {
      contexts.push({
        source_type: "price_list",
        source_id: priceList.id,
        region_id: ruleValue(price, "region_id"),
        currency_code: price.currency_code,
      });
    }
  }
  return contexts;
}

async function shippingOptionsAsContexts(sdk) {
  const { shipping_options } = await sdk.admin.shippingOption.list({
    fields: "id,name,*prices,*prices.price_rules",
    limit: 100,
  });
  const contexts = [];
  for (const option of shipping_options) {
    for (const price of option.prices || []) {
      contexts.push({
        source_type: "shipping_option",
        source_id: option.id,
        region_id: ruleValue(price, "region_id"),
        currency_code: price.currency_code,
      });
    }
  }
  return contexts;
}

async function ordersWithBadTotals(sdk) {
  const { orders } = await sdk.admin.order.list({
    fields: "id,region_id,currency_code,subtotal,tax_total,shipping_total,total",
    limit: 100,
  });
  return orders.filter((order) => {
    const expected = (order.subtotal || 0) + (order.tax_total || 0) + (order.shipping_total || 0);
    return Math.abs(expected - (order.total || 0)) > ROUNDING_TOLERANCE;
  });
}

async function upsertPricePreference(sdk, attribute, value, isTaxInclusive) {
  return sdk.admin.pricePreference.create({
    attribute,
    value,
    is_tax_inclusive: isTaxInclusive,
  });
}

export async function run() {
  const sdk = await getSdk();

  const preferences = await listPricePreferences(sdk);
  const priceContexts = [...(await priceListsAsContexts(sdk)), ...(await shippingOptionsAsContexts(sdk))];
  const mismatches = findTaxInclusivityMismatches(preferences, priceContexts);

  for (const mismatch of mismatches) {
    console.warn(
      `${mismatch.source_type} ${mismatch.source_id}: region=${mismatch.region_id} currency=${mismatch.currency_code} region_pref=${mismatch.region_pref} currency_pref=${mismatch.currency_pref} reason=${mismatch.reason}`
    );
  }

  const badOrders = await ordersWithBadTotals(sdk);
  for (const order of badOrders) {
    console.warn(
      `Order ${order.id} totals do not reconcile: subtotal=${order.subtotal} tax_total=${order.tax_total} shipping_total=${order.shipping_total} total=${order.total}`
    );
  }

  let applied = 0;
  if (APPLY_FIX_FOR) {
    console.log(`${DRY_RUN ? "Would call" : "Calling"} POST /admin/price-preferences ${JSON.stringify(APPLY_FIX_FOR)}`);
    if (!DRY_RUN) {
      await upsertPricePreference(sdk, APPLY_FIX_FOR.attribute, APPLY_FIX_FOR.value, APPLY_FIX_FOR.is_tax_inclusive);
    }
    applied = 1;
  }

  console.log(
    `Done. ${mismatches.length} mismatch(es) flagged, ${badOrders.length} order(s) with bad totals, ${applied} preference write ${DRY_RUN ? "to apply" : "applied"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
