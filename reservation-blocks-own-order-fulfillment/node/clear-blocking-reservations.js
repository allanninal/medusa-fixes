/**
 * Clear Medusa reservations that block fulfillment of their own order.
 *
 * Medusa v2 computes an inventory level's available quantity as stocked_quantity
 * minus reserved_quantity, and the admin fulfillment checks gate on that number
 * being above zero. They never subtract out the reservation belonging to the
 * order being fulfilled, so once reserved_quantity reaches stocked_quantity on
 * the last unit sold, the very order that holds the reservation is told there is
 * zero available. This is worse when reservations are orphaned: left behind
 * after an order is canceled or archived, or after a fulfillment bug fails to
 * delete them. This scans reservations, resolves each one's order, and deletes
 * only the ones confirmed orphaned. Anything tied to an open order is left
 * alone and, if stuck, reported for manual review.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/reservation-blocks-own-order-fulfillment/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORPHAN_ORDER_STATUSES = new Set(["canceled", "archived"]);
const ALREADY_FULFILLED_STATUSES = new Set(["fulfilled", "shipped", "delivered"]);
const ORPHAN_OUTCOMES = new Set(["orphan_canceled_order", "orphan_missing_order", "orphan_already_fulfilled"]);

/**
 * Pure decision function. No I/O.
 *
 * Decision logic:
 *   1. No line_item_id -> manual/custom reservation, never touched -> "manual_keep"
 *   2. line_item_id set but orderInfo is null or order does not exist
 *      (order/line item hard-deleted) -> "orphan_missing_order"
 *   3. orderInfo.status is "canceled" or "archived" -> "orphan_canceled_order"
 *   4. orderInfo.fulfillment_status in {"fulfilled", "shipped", "delivered"}
 *      (fulfillment should have zeroed and deleted this reservation already)
 *      -> "orphan_already_fulfilled"
 *   5. Otherwise the reservation legitimately backs an open, unfulfilled order
 *      -> "keep"
 *
 * A caller then filters the location's level entry (stocked_quantity === reserved_quantity)
 * to confirm this reservation is part of a fully exhausted, blocking level before repair.
 *
 * @param {{ id: string, line_item_id: string | null, quantity: number, location_id: string }} reservation
 * @param {{ exists: boolean, status?: string, fulfillment_status?: string } | null} orderInfo
 * @param {{ location_id: string, stocked_quantity: number, reserved_quantity: number }[]} levels
 * @returns {"keep" | "orphan_canceled_order" | "orphan_missing_order" | "orphan_already_fulfilled" | "manual_keep"}
 */
export function classifyReservation(reservation, orderInfo, levels) {
  if (!reservation.line_item_id) return "manual_keep";

  if (!orderInfo || !orderInfo.exists) return "orphan_missing_order";

  if (ORPHAN_ORDER_STATUSES.has(orderInfo.status)) return "orphan_canceled_order";

  if (ALREADY_FULFILLED_STATUSES.has(orderInfo.fulfillment_status)) return "orphan_already_fulfilled";

  return "keep";
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

async function adminDelete(token, path) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on DELETE ${path}`);
  return res.json();
}

async function listReservations(token) {
  const reservations = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/reservations", {
      fields: "id,quantity,line_item_id,inventory_item_id,location_id,created_at,*line_item.order",
      limit,
      offset,
    });
    reservations.push(...data.reservations);
    offset += limit;
    if (offset >= data.count) return reservations;
  }
}

function resolveOrderInfo(reservation) {
  const lineItem = reservation.line_item;
  if (!lineItem) return null;
  const order = lineItem.order;
  if (!order) return null;
  return {
    exists: true,
    status: order.status,
    fulfillment_status: order.fulfillment_status,
  };
}

async function getLocationLevels(token, inventoryItemId) {
  const data = await adminGet(token, `/admin/inventory-items/${inventoryItemId}/location-levels`);
  return data.inventory_levels || [];
}

function findLevel(levels, locationId) {
  return levels.find((l) => l.location_id === locationId) || null;
}

export async function run() {
  const token = await getAdminToken();
  const reservations = await listReservations(token);

  let cleared = 0;
  let flaggedForReview = 0;
  for (const reservation of reservations) {
    if (!reservation.line_item_id) continue; // manual_keep, never touched

    const orderInfo = resolveOrderInfo(reservation);
    const levels = await getLocationLevels(token, reservation.inventory_item_id);
    const outcome = classifyReservation(reservation, orderInfo, levels);

    if (outcome === "keep") {
      const level = findLevel(levels, reservation.location_id);
      if (level && level.reserved_quantity === level.stocked_quantity) {
        const orderId = reservation.line_item?.order?.id;
        console.warn(
          `Order ${orderId}: reservation ${reservation.id} keeps reserved_quantity == stocked_quantity ` +
          `at location ${reservation.location_id}. Flagging for manual review, not touching stock or fulfillment.`
        );
        flaggedForReview++;
      }
      continue;
    }

    if (!ORPHAN_OUTCOMES.has(outcome)) continue;

    const level = findLevel(levels, reservation.location_id);
    const beforeReserved = level ? level.reserved_quantity : undefined;
    const stocked = level ? level.stocked_quantity : undefined;
    const afterReserved = beforeReserved !== undefined ? beforeReserved - reservation.quantity : undefined;

    console.warn(
      `Reservation ${reservation.id} classified as ${outcome}. inventory_item_id=${reservation.inventory_item_id} ` +
      `location_id=${reservation.location_id} quantity=${reservation.quantity} ` +
      `reserved_quantity ${beforeReserved} -> ${afterReserved} (stocked_quantity=${stocked}). ` +
      `${DRY_RUN ? "Would delete" : "Deleting"}`
    );

    if (!DRY_RUN) {
      await adminDelete(token, `/admin/reservations/${reservation.id}`);
    }

    cleared++;
  }

  console.log(
    `Done. ${cleared} orphaned reservation(s) ${DRY_RUN ? "to clear" : "cleared"}. ` +
    `${flaggedForReview} order(s) flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
