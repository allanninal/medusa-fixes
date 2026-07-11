/**
 * Find Medusa multi-part product location levels where reserved_quantity
 * has drifted from the live reservations, typically negative, because
 * allocate-items and fulfillment disagreed on the required_quantity multiplier.
 * Flags and reports by default. Only resyncs reserved_quantity to the computed
 * live sum when DRY_RUN is false and an operator has confirmed. Safe to run
 * again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/negative-reserved-quantity-bundles/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const CONFIRM_RESYNC = (process.env.CONFIRM_RESYNC || "false").toLowerCase() === "true";

const PRODUCT_FIELDS =
  "id,title,variants.id,variants.title,*variants.inventory_items," +
  "variants.inventory_items.required_quantity";

/**
 * Pure: no I/O. liveReservations is an array of { quantity: number, ... }.
 *
 * computedReserved sums quantity across liveReservations.
 * drift = storedReservedQuantity - computedReserved.
 * isNegativeAnomaly = storedReservedQuantity < 0.
 * needsResync = isNegativeAnomaly or drift !== 0.
 */
export function computeReservedQuantityDrift(storedReservedQuantity, liveReservations) {
  const computedReserved = liveReservations.reduce((sum, r) => sum + r.quantity, 0);
  const drift = storedReservedQuantity - computedReserved;
  const isNegativeAnomaly = storedReservedQuantity < 0;
  const needsResync = isNegativeAnomaly || drift !== 0;
  return { computedReserved, drift, isNegativeAnomaly, needsResync };
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listMultipartVariants(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.product.list({ fields: PRODUCT_FIELDS, limit, offset });
    for (const product of body.products) {
      for (const variant of product.variants || []) {
        const items = variant.inventory_items || [];
        if (items.length === 1 && (items[0].required_quantity ?? 1) > 1) {
          out.push({ product: product.title, variant, inventoryItem: items[0] });
        }
      }
    }
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function listReservations(sdk, inventoryItemId, locationId) {
  const out = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const body = await sdk.admin.reservation.list({
      inventory_item_id: inventoryItemId,
      location_id: locationId,
      limit,
      offset,
    });
    out.push(...body.reservations);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function getLocationLevels(sdk, inventoryItemId) {
  const body = await sdk.admin.inventoryItem.retrieveLocationLevels(inventoryItemId, {});
  return body.inventory_item.location_levels;
}

async function hasInFlightOrder(sdk, inventoryItemId) {
  // Skip a row if any reservation for it looks detached from a real order
  // line, since we cannot confirm it is safe to resync while that is true.
  const body = await sdk.admin.reservation.list({ inventory_item_id: inventoryItemId, limit: 1 });
  return body.reservations.some((res) => !res.line_item_id);
}

async function resyncLocationLevel(sdk, inventoryItemId, locationId, computedReserved) {
  return sdk.admin.inventoryItem.updateLocationLevel(inventoryItemId, locationId, {
    reserved_quantity: computedReserved,
  });
}

export async function run() {
  const sdk = await login();
  const variants = await listMultipartVariants(sdk);

  let flagged = 0;
  let resynced = 0;
  for (const entry of variants) {
    const inventoryItemId = entry.inventoryItem.id;
    const levels = await getLocationLevels(sdk, inventoryItemId);
    for (const level of levels) {
      const locationId = level.location_id;
      const liveReservations = await listReservations(sdk, inventoryItemId, locationId);
      const decision = computeReservedQuantityDrift(level.reserved_quantity, liveReservations);
      if (!decision.needsResync) continue;

      flagged++;
      console.warn(
        `Product ${entry.product} variant ${entry.variant.title}, item ${inventoryItemId} ` +
        `at location ${locationId}: stored=${level.reserved_quantity} live_sum=${decision.computedReserved} ` +
        `drift=${decision.drift} negative=${decision.isNegativeAnomaly}`
      );

      if (DRY_RUN || !CONFIRM_RESYNC) continue;

      if (await hasInFlightOrder(sdk, inventoryItemId)) {
        console.log(`Skipping item ${inventoryItemId} at location ${locationId}, an order or fulfillment looks in flight.`);
        continue;
      }

      const before = level.reserved_quantity;
      await resyncLocationLevel(sdk, inventoryItemId, locationId, decision.computedReserved);
      resynced++;
      console.log(`Resynced item ${inventoryItemId} at location ${locationId}. before=${before} after=${decision.computedReserved}`);
    }
  }

  if (flagged === 0) {
    console.log(`No drifted reserved_quantity rows found across ${variants.length} multi-part variant(s).`);
    return;
  }

  if (DRY_RUN || !CONFIRM_RESYNC) {
    console.log(`Done. ${flagged} row(s) flagged. Set DRY_RUN=false and CONFIRM_RESYNC=true to resync.`);
  } else {
    console.log(`Done. ${flagged} row(s) flagged, ${resynced} resynced.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
