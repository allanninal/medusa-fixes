/**
 * Detect Medusa publishable keys whose multi-channel scope makes variants read zero stock.
 *
 * In Medusa v2, the Store API is supposed to resolve a variant's available inventory
 * by unioning the stock locations linked to every sales channel a publishable key is
 * scoped to, then summing stocked_quantity minus reserved_quantity across those
 * locations. A known bug (medusajs/medusa#7907, and the related sales_channel_id
 * stripping regression in #12209) only handles a key scoped to exactly one sales
 * channel. When a key is scoped to more than one, the location filter can be
 * silently narrowed to a single channel or dropped entirely, so the join returns
 * no rows and inventory_quantity is computed as 0 even though the admin API shows
 * real stock at the linked locations.
 *
 * This script never writes anything, in DRY_RUN or not, because the defect lives in
 * Medusa core's request-scoping logic (or a custom middleware reproducing it), not
 * in the store's data. It only reads the admin's location levels and the Store
 * API's reported quantity for a sample of products under a real publishable key,
 * classifies each variant with a pure decision function, and reports every mismatch
 * whose fingerprint matches this bug.
 *
 * Guide: https://www.allanninal.dev/medusa/multi-channel-key-zero-stock/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY || "pk_dummy";
const PUBLISHABLE_KEY_ID = (process.env.MEDUSA_PUBLISHABLE_KEY_ID || "").trim() || null;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true"; // no write path exists either way

/**
 * Pure decision function. No I/O.
 *
 * @param {string[]} publishableKeyScopeSalesChannelIds
 * @param {Record<string, {stockedQuantity: number, reservedQuantity: number}>} adminLocationLevelsByLocationId
 * @param {Record<string, string[]>} expectedStockLocationIdsByChannel
 * @param {number} storeReportedInventoryQuantity
 * @returns {{isBug: boolean, expectedAvailable: number, reason: string}}
 */
export function diagnoseZeroStockMismatch(
  publishableKeyScopeSalesChannelIds,
  adminLocationLevelsByLocationId,
  expectedStockLocationIdsByChannel,
  storeReportedInventoryQuantity
) {
  const expectedLocationIds = new Set();
  for (const channelId of publishableKeyScopeSalesChannelIds) {
    for (const locId of expectedStockLocationIdsByChannel[channelId] || []) {
      expectedLocationIds.add(locId);
    }
  }

  let expectedAvailable = 0;
  for (const locationId of expectedLocationIds) {
    const level = adminLocationLevelsByLocationId[locationId];
    if (!level) continue;
    expectedAvailable += Math.max(level.stockedQuantity - level.reservedQuantity, 0);
  }

  const isMultiChannel = publishableKeyScopeSalesChannelIds.length > 1;
  if (isMultiChannel && expectedAvailable > 0 && storeReportedInventoryQuantity === 0) {
    return { isBug: true, expectedAvailable, reason: "multi-channel-key-zero-stock" };
  }
  if (expectedAvailable <= 0) {
    return { isBug: false, expectedAvailable, reason: "genuinely-out-of-stock" };
  }
  return { isBug: false, expectedAvailable, reason: "ok" };
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

async function keySalesChannelIds(token, keyId) {
  const data = await adminGet(token, `/admin/api-keys/${keyId}`, { fields: "id,*sales_channels" });
  return (data.api_key.sales_channels || []).map((ch) => ch.id);
}

async function stockLocationsByChannel(token, salesChannelIds) {
  const data = await adminGet(token, "/admin/stock-locations", { fields: "id,name,*sales_channels", limit: 200 });
  const byChannel = {};
  for (const scId of salesChannelIds) byChannel[scId] = [];
  for (const loc of data.stock_locations) {
    for (const ch of loc.sales_channels || []) {
      if (ch.id in byChannel) byChannel[ch.id].push(loc.id);
    }
  }
  return byChannel;
}

async function adminLocationLevelsByLocationId(token, productId) {
  const data = await adminGet(token, `/admin/products/${productId}`, {
    fields:
      "id,*variants.inventory_items.inventory.location_levels.stocked_quantity," +
      "*variants.inventory_items.inventory.location_levels.reserved_quantity",
  });
  const product = data.product;
  const levelsByVariant = {};
  for (const variant of product.variants || []) {
    const byLocation = {};
    for (const item of variant.inventory_items || []) {
      const inventory = item.inventory || {};
      for (const lvl of inventory.location_levels || []) {
        byLocation[lvl.location_id] = {
          stockedQuantity: lvl.stocked_quantity,
          reservedQuantity: lvl.reserved_quantity,
        };
      }
    }
    levelsByVariant[variant.id] = byLocation;
  }
  return { product, levelsByVariant };
}

async function storeInventoryQuantities(publishableKey, productId) {
  const url = new URL(`${BACKEND_URL}/store/products/${productId}`);
  url.searchParams.set("fields", "id,title,*variants.inventory_quantity");
  const res = await fetch(url, { headers: { "x-publishable-api-key": publishableKey } });
  if (!res.ok) throw new Error(`Medusa store ${res.status}`);
  const body = await res.json();
  const map = {};
  for (const v of body.product.variants || []) map[v.id] = v.inventory_quantity;
  return map;
}

async function sampleProductIds(token, limit = 25) {
  const data = await adminGet(token, "/admin/products", { limit, fields: "id" });
  return data.products.map((p) => p.id);
}

export async function run() {
  const token = await getAdminToken();
  if (!PUBLISHABLE_KEY_ID) {
    throw new Error("Set MEDUSA_PUBLISHABLE_KEY_ID to the api key's admin id (pk_...) to resolve its scope.");
  }

  const channelIds = await keySalesChannelIds(token, PUBLISHABLE_KEY_ID);
  const expectedLocationsByChannel = await stockLocationsByChannel(token, channelIds);
  console.log(`Key ${PUBLISHABLE_KEY_ID} is scoped to ${channelIds.length} sales channel(s).`);

  let mismatches = 0;
  for (const productId of await sampleProductIds(token)) {
    const { product, levelsByVariant } = await adminLocationLevelsByLocationId(token, productId);
    const storeQuantities = await storeInventoryQuantities(PUBLISHABLE_KEY, productId);

    for (const variant of product.variants || []) {
      const variantId = variant.id;
      const storeQty = storeQuantities[variantId];
      if (storeQty === undefined) continue;
      const decision = diagnoseZeroStockMismatch(
        channelIds,
        levelsByVariant[variantId] || {},
        expectedLocationsByChannel,
        storeQty
      );
      if (decision.isBug) {
        mismatches++;
        console.warn(
          `MISMATCH product=${productId} variant=${variantId} key=${PUBLISHABLE_KEY_ID} channels=${channelIds.length} admin_expected=${decision.expectedAvailable} store_reported=${storeQty} reason=${decision.reason}`
        );
      }
    }
  }

  console.log(`Done. ${mismatches} mismatch(es) found. No write operations were performed (DRY_RUN=${DRY_RUN}).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
