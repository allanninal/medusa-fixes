/**
 * Find Medusa v2 variants that have no price in a region's currency.
 *
 * Every region has one currency_code. A variant is only purchasable in that
 * region if its price set has a Price row in that currency. This script lists
 * every region and every product's variants, then reports every {variant,
 * region} pair that is missing a price. It only reports by default. Filling a
 * gap is a separate, human-approved step behind DRY_RUN.
 *
 * Guide: https://www.allanninal.dev/medusa/product-has-no-price-in-a-region/
 */
import { pathToFileURL } from "node:url";

const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure set-difference logic. No I/O.
 *
 * For each variant, build the set of lowercase currency_codes it has
 * prices for. For each region, if that set does not contain the
 * region's currency_code (case-insensitive), record a gap.
 */
export function findMissingRegionPrices(variants, regions) {
  const gaps = [];
  for (const variant of variants) {
    const pricedCurrencies = new Set(
      (variant.prices || []).map((p) => (p.currency_code || "").toLowerCase())
    );
    for (const region of regions) {
      const regionCurrency = (region.currency_code || "").toLowerCase();
      if (!pricedCurrencies.has(regionCurrency)) {
        gaps.push({
          variant_id: variant.id,
          sku: variant.sku,
          region_id: region.id,
          region_name: region.name,
          missing_currency_code: region.currency_code,
        });
      }
    }
  }
  return gaps;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listRegions(sdk) {
  const { regions } = await sdk.admin.region.list({
    fields: "id,name,currency_code",
    limit: 1000,
  });
  return regions;
}

async function* listProducts(sdk) {
  const limit = 100;
  let offset = 0;
  while (true) {
    const body = await sdk.admin.product.list({
      fields: "id,title,status,*variants,*variants.prices",
      limit,
      offset,
    });
    for (const product of body.products) yield product;
    offset += limit;
    if (offset >= body.count) return;
  }
}

// Only called when DRY_RUN is false and a human supplied the amount.
// The variant update route accepts a `prices` array that upserts the
// whole price set, so we send the existing prices plus the new one.
async function fillMissingPrice(sdk, productId, variantId, existingPrices, currencyCode, amount) {
  const newPrices = [...existingPrices, { currency_code: currencyCode, amount }];
  return sdk.admin.product.updateVariant(productId, variantId, { prices: newPrices });
}

export async function run() {
  const sdk = await getSdk();
  const regions = await listRegions(sdk);
  let totalGaps = 0;
  for await (const product of listProducts(sdk)) {
    const variants = product.variants || [];
    const gaps = findMissingRegionPrices(variants, regions);
    for (const gap of gaps) {
      console.warn(
        `Product ${product.title} variant ${gap.variant_id} (${gap.sku}) has no price for region ${gap.region_name} (${gap.missing_currency_code}).`
      );
      totalGaps++;
    }
  }
  console.log(`Done. ${totalGaps} gap(s) ${DRY_RUN ? "found" : "found (dry run off, no auto-fill wired in)"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
