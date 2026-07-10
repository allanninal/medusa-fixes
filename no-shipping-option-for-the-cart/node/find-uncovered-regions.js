/**
 * Find Medusa regions whose countries have no matching shipping coverage, safely.
 *
 * Shipping availability for a cart is resolved by walking cart to sales channel
 * to stock location to FulfillmentSet to ServiceZone to GeoZone, and matching
 * the cart's shipping_address.country_code against a GeoZone. Regions control
 * checkout availability and currency, and are configured independently of
 * service zone geo zones, so a merchant can add a country to a Region without
 * ever adding a matching GeoZone to any ServiceZone, or without linking the
 * right stock location to the sales channel. That leaves the country's carts
 * with a zero length shipping_options array even though the region, product,
 * and pricing all look correct.
 *
 * This script reports every uncovered (sales_channel, country) pair. It does
 * not create service zones, geo zones, or shipping options automatically,
 * since that is a business decision about which countries to actually ship
 * to, carrier rates, and tax nexus. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/no-shipping-option-for-the-cart/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

// Only used if an operator explicitly opts into the guarded repair path.
const FULFILLMENT_SET_ID = (process.env.FULFILLMENT_SET_ID || "").trim() || null;
const SERVICE_ZONE_ID = (process.env.SERVICE_ZONE_ID || "").trim() || null;
const SHIPPING_PROFILE_ID = (process.env.SHIPPING_PROFILE_ID || "").trim() || null;
const PROVIDER_ID = (process.env.PROVIDER_ID || "").trim() || null;

export function findUncoveredRegions(regions, stockLocations) {
  const results = [];
  for (const region of regions) {
    for (const salesChannelId of region.salesChannelIds || []) {
      const locationsForChannel = stockLocations.filter((loc) =>
        (loc.salesChannelIds || []).includes(salesChannelId)
      );
      for (const countryCode of region.countryCodes || []) {
        let matchedZone = null;
        outer: for (const loc of locationsForChannel) {
          for (const fset of loc.fulfillmentSets || []) {
            for (const zone of fset.serviceZones || []) {
              for (const gz of zone.geoZones || []) {
                if (gz.type === "country" && gz.countryCode === countryCode) {
                  matchedZone = zone;
                  break outer;
                }
              }
            }
          }
        }

        if (!matchedZone) {
          results.push({ salesChannelId, countryCode, reason: "no_geo_zone_match" });
          continue;
        }

        const options = matchedZone.shippingOptions || [];
        if (options.length === 0 || options.every(isExcluded)) {
          results.push({ salesChannelId, countryCode, reason: "zone_matched_no_shipping_options" });
        }
      }
    }
  }
  return results;
}

function isExcluded(option) {
  return (option.rules || []).some(
    (rule) =>
      rule.attribute === "cart.subtotal" &&
      (rule.operator === "gt" || rule.operator === "gte") &&
      typeof rule.value === "number" &&
      rule.value > 0
  );
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getRegions(sdk) {
  const { regions } = await sdk.admin.region.list({ fields: "id,name,*countries" });
  return regions.map((region) => ({
    id: region.id,
    countryCodes: (region.countries || []).map((c) => c.iso_2).filter(Boolean),
    salesChannelIds: (region.sales_channels || []).map((sc) => sc.id).length
      ? region.sales_channels.map((sc) => sc.id)
      : [region.id],
  }));
}

async function getStockLocations(sdk) {
  const { stock_locations } = await sdk.admin.stockLocation.list({
    fields:
      "id,name,*sales_channels,*fulfillment_sets," +
      "*fulfillment_sets.service_zones," +
      "*fulfillment_sets.service_zones.geo_zones," +
      "*fulfillment_sets.service_zones.shipping_options",
  });
  return stock_locations.map((loc) => ({
    id: loc.id,
    salesChannelIds: (loc.sales_channels || []).map((sc) => sc.id),
    fulfillmentSets: (loc.fulfillment_sets || []).map((fset) => ({
      serviceZones: (fset.service_zones || []).map((zone) => ({
        geoZones: (zone.geo_zones || []).map((gz) => ({
          type: gz.type,
          countryCode: gz.country_code,
        })),
        shippingOptions: (zone.shipping_options || []).map((opt) => ({
          id: opt.id,
          rules: opt.rules || [],
        })),
      })),
    })),
  }));
}

function printPlannedRepair(gap) {
  console.log(
    `  [DRY RUN] would POST /admin/fulfillment-sets/${FULFILLMENT_SET_ID}/service-zones/${SERVICE_ZONE_ID}/geo-zones ` +
      `{type: "country", country_code: "${gap.countryCode}"}`
  );
  console.log(
    `  [DRY RUN] would POST /admin/shipping-options ` +
      `{service_zone_id: "${SERVICE_ZONE_ID}", shipping_profile_id: "${SHIPPING_PROFILE_ID}", provider_id: "${PROVIDER_ID}", prices: [...]}`
  );
}

async function applyRepair(sdk, gap) {
  return sdk.admin.fulfillmentSet.createServiceZoneGeoZones(FULFILLMENT_SET_ID, SERVICE_ZONE_ID, {
    type: "country",
    country_code: gap.countryCode,
  });
}

export async function run() {
  const sdk = await getSdk();
  const regions = await getRegions(sdk);
  const stockLocations = await getStockLocations(sdk);

  const gaps = findUncoveredRegions(regions, stockLocations);

  if (gaps.length === 0) {
    console.log("No gaps found. Every region country has a matching service zone with usable shipping options.");
    return;
  }

  const canRepair = FULFILLMENT_SET_ID && SERVICE_ZONE_ID && SHIPPING_PROFILE_ID && PROVIDER_ID;
  for (const gap of gaps) {
    console.log(`Gap: sales_channel=${gap.salesChannelId} country=${gap.countryCode} reason=${gap.reason}`);
    if (canRepair) {
      printPlannedRepair(gap);
      if (!DRY_RUN) {
        await applyRepair(sdk, gap);
        console.log("  Applied. Re-verify with a synthetic cart before trusting checkout.");
      }
    }
  }

  console.log(`Done. ${gaps.length} uncovered (sales_channel, country) pair(s) found.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
