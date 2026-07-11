/**
 * Find Medusa orders whose reservation decremented stock at the wrong location.
 *
 * A stock location's availability for a sale is supposed to be scoped by the
 * sales channel the order was placed through, using the SalesChannelLocation
 * link between the Stock Location and Sales Channel modules. A bug tracked as
 * medusajs/medusa issue 10658 meant the cart completion and order edit
 * workflows could collect every stock location tied to an inventory item
 * without filtering by the order's own sales channel, so a reservation could
 * land at a location that belongs to a different channel entirely. This walks
 * recent orders, resolves the expected location with a pure function, and
 * reports every mismatch. It never rewrites a reservation on its own; a
 * corrective plan is only logged, and only for orders whose items are not yet
 * fulfilled. Run once, or on a schedule.
 *
 * Guide: https://www.allanninal.dev/medusa/inventory-wrong-stock-location/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const ORDER_LIMIT = Number(process.env.ORDER_LIMIT || 50);

export function pickExpectedLocationId(locationLevels, salesChannelLocationIds, actualLocationId) {
  const linkedIds = new Set(salesChannelLocationIds);
  const matches = locationLevels.filter((lvl) => linkedIds.has(lvl.location_id));
  const expectedLocationId = matches.length ? matches[0].location_id : null;
  const isMismatch = expectedLocationId !== null && expectedLocationId !== actualLocationId;
  return { expectedLocationId, isMismatch };
}

function itemIsFulfilled(item) {
  return (item.fulfilled_quantity || 0) > 0;
}

async function getSdk() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BACKEND_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  return sdk;
}

async function getRecentOrders(sdk, limit) {
  const { orders } = await sdk.admin.order.list({
    fields: "id,display_id,sales_channel_id,*items,*items.variant",
    limit,
  });
  return orders;
}

async function getSalesChannelLocationIds(sdk, salesChannelId) {
  const { sales_channel } = await sdk.admin.salesChannel.retrieve(salesChannelId, {
    fields: "id,*stock_locations",
  });
  return (sales_channel.stock_locations || []).map((loc) => loc.id);
}

async function getLocationLevels(sdk, inventoryItemId) {
  const { inventory_levels } = await sdk.admin.inventoryItem.listLocationLevels(inventoryItemId, {
    fields: "location_id,stocked_quantity,reserved_quantity",
  });
  return inventory_levels;
}

async function getReservationsForLineItem(sdk, lineItemId) {
  const { reservations } = await sdk.admin.reservation.list({
    line_item_id: lineItemId,
    fields: "id,location_id,inventory_item_id,quantity,line_item_id",
  });
  return reservations;
}

export async function run() {
  const sdk = await getSdk();
  const orders = await getRecentOrders(sdk, ORDER_LIMIT);

  const channelLocationCache = new Map();
  let flagged = 0;
  let corrected = 0;

  for (const order of orders) {
    const salesChannelId = order.sales_channel_id;
    if (!salesChannelId) continue;
    if (!channelLocationCache.has(salesChannelId)) {
      channelLocationCache.set(salesChannelId, await getSalesChannelLocationIds(sdk, salesChannelId));
    }
    const linkedIds = channelLocationCache.get(salesChannelId);

    for (const item of order.items || []) {
      const variant = item.variant || {};
      const inventoryItems = variant.inventory_items || [];
      for (const inv of inventoryItems) {
        const inventoryItemId = inv.inventory?.id || inv.inventory_item_id;
        if (!inventoryItemId) continue;
        const locationLevels = await getLocationLevels(sdk, inventoryItemId);
        const reservations = await getReservationsForLineItem(sdk, item.id);

        for (const reservation of reservations) {
          const decision = pickExpectedLocationId(locationLevels, linkedIds, reservation.location_id);
          if (!decision.isMismatch) continue;

          flagged++;
          console.warn(
            `Order ${order.display_id}: reservation ${reservation.id} used location ${reservation.location_id}, expected one linked to sales channel ${salesChannelId} (${decision.expectedLocationId})`
          );

          if (itemIsFulfilled(item)) {
            console.warn(`Order ${order.display_id}: item already fulfilled, flagging for manual stock adjustment only`);
            continue;
          }

          console.log(
            `${DRY_RUN ? "Would correct" : "Correcting"} reservation ${reservation.id}: location ${reservation.location_id} -> ${decision.expectedLocationId}`
          );
          if (!DRY_RUN) {
            // Deliberately left as a logged plan. Recreating a reservation at the correct
            // location is a destructive two-step write (delete then re-create) and should
            // only run after an operator has confirmed the order is genuinely unfulfilled
            // and the target location is correct.
            console.warn(
              `Order ${order.display_id}: DRY_RUN is off, but this script only reports. Confirm manually, then delete reservation ${reservation.id} and recreate it with location_id=${decision.expectedLocationId} before shipping.`
            );
          }
          corrected++;
        }
      }
    }
  }

  console.log(`Done. ${flagged} mismatch(es) found, ${corrected} eligible for a guarded correction.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
