/**
 * Find Medusa v2 fulfillments that cannot cancel because their inventory
 * location level has already gone negative.
 *
 * cancelFulfillmentWorkflow restores stock on the location level tied to a
 * fulfillment's line items. If that level's available stock (stocked_quantity
 * minus reserved_quantity) is already negative, from an earlier oversell, a
 * direct external write, or a drifted reservation, the restore step can fail
 * or leave the level worse off, so the fulfillment is stuck: neither canceled
 * nor usable. This script only reports blocked fulfillments. It never writes
 * a location level and never calls the cancel route. Safe to run again and
 * again.
 *
 * Guide: https://www.allanninal.dev/medusa/cancel-fulfillment-negative-stock/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "dummy";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No network calls.
 *
 * A fulfillment cancel is blocked when the fulfillment is still active
 * (not already canceled) and the inventory location level it depends on
 * already has negative available stock (stocked_quantity - reserved_quantity).
 */
export function isCancelBlockedByNegativeStock(fulfillment, locationLevel) {
  if (fulfillment.canceled_at) return false;
  if (!locationLevel) return false;
  const { stocked_quantity: stocked, reserved_quantity: reserved } = locationLevel;
  if (stocked == null || reserved == null) return false;
  const available = stocked - reserved;
  return available < 0;
}

export function fulfillmentInventoryRefs(fulfillment) {
  const locationId = fulfillment.location_id;
  const refs = [];
  for (const item of fulfillment.items || []) {
    if (item.inventory_item_id && locationId) {
      refs.push([item.inventory_item_id, locationId]);
    }
  }
  return refs;
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function adminGet(token, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function* activeFulfillments(token) {
  const limit = 50;
  let offset = 0;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,display_id,*fulfillments,*fulfillments.items",
      limit,
      offset,
    });
    for (const order of data.orders) {
      for (const f of order.fulfillments || []) {
        if (f.canceled_at) continue;
        yield [order, f];
      }
    }
    offset += limit;
    if (offset >= data.count) return;
  }
}

async function locationLevelFor(token, inventoryItemId, locationId) {
  const data = await adminGet(token, `/admin/inventory-items/${inventoryItemId}/location-levels`, {
    location_id: locationId,
  });
  const levels = data.inventory_item?.location_levels || [];
  return levels.find((lvl) => lvl.location_id === locationId) || null;
}

export async function run() {
  const token = await getToken();
  const blocked = [];
  for await (const [order, fulfillment] of activeFulfillments(token)) {
    for (const [inventoryItemId, locationId] of fulfillmentInventoryRefs(fulfillment)) {
      const level = await locationLevelFor(token, inventoryItemId, locationId);
      if (isCancelBlockedByNegativeStock(fulfillment, level)) {
        blocked.push({
          orderId: order.id,
          displayId: order.display_id,
          fulfillmentId: fulfillment.id,
          inventoryItemId,
          locationId,
          stockedQuantity: level.stocked_quantity,
          reservedQuantity: level.reserved_quantity,
        });
        console.warn(
          `Order ${order.display_id} fulfillment ${fulfillment.id} blocked. Location ${locationId} available=${level.stocked_quantity - level.reserved_quantity}.`
        );
      }
    }
  }
  console.log(
    `Done. ${blocked.length} fulfillment(s) blocked by negative stock. ${DRY_RUN ? "(dry run, report only)" : "(report only, no writes made)"}`
  );
  return blocked;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
