/**
 * Find and delete Medusa inventory reservations left over after fulfillment.
 *
 * Medusa v2 creates a ReservationItem linking an inventory_item_id, location_id,
 * and the order's line_item_id whenever a line item is purchased. The intended
 * lifecycle deletes that row once the line item is fulfilled, but the delete step
 * is not transactionally guaranteed. When a variant has multiple inventory items,
 * or the fulfillment and order completion handlers race or partially fail, the
 * reservation can survive an order that is already completed or canceled. This
 * lists closed orders, resolves the reservations tied to their line items, and
 * deletes only the ones whose order status and fulfillment status are both
 * terminal.
 * Run as a scheduled reconciler. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/stale-reservation-after-fulfillment/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const TERMINAL_ORDER_STATUSES = new Set(["completed", "canceled"]);
const TERMINAL_FULFILLMENT_STATUSES = new Set(["fulfilled", "delivered", "canceled"]);

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, status: string, fulfillment_status: string, items: { id: string }[] }[]} orders
 * @param {{ id: string, line_item_id: string | null, quantity: number }[]} reservations
 * @returns {{ reservation_id: string, order_id: string, line_item_id: string, quantity: number }[]}
 *
 * Builds a lookup from line_item_id to the order that owns it, then keeps a
 * reservation only when that order's status is in TERMINAL_ORDER_STATUSES and
 * its fulfillment_status is in TERMINAL_FULFILLMENT_STATUSES.
 */
export function findStaleReservations(orders, reservations) {
  const lineItemToOrder = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      lineItemToOrder.set(item.id, order);
    }
  }

  const stale = [];
  for (const reservation of reservations) {
    const lineItemId = reservation.line_item_id;
    if (!lineItemId) continue;
    const order = lineItemToOrder.get(lineItemId);
    if (!order) continue;
    if (!TERMINAL_ORDER_STATUSES.has(order.status)) continue;
    if (!TERMINAL_FULFILLMENT_STATUSES.has(order.fulfillment_status)) continue;
    stale.push({
      reservation_id: reservation.id,
      order_id: order.id,
      line_item_id: lineItemId,
      quantity: reservation.quantity,
    });
  }
  return stale;
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
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
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

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function listClosedOrders(token) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      "status[]": ["completed", "canceled"],
      fields: "id,display_id,status,fulfillment_status,*items",
      limit,
      offset,
    });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

async function listReservationsForLineItems(token, lineItemIds) {
  const reservations = [];
  for (const batch of chunk(lineItemIds, 100)) {
    if (!batch.length) continue;
    const data = await adminGet(token, "/admin/reservations", {
      "line_item_id[]": batch,
      fields: "id,line_item_id,inventory_item_id,location_id,quantity,created_at",
      limit: 200,
    });
    reservations.push(...data.reservations);
  }
  return reservations;
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listClosedOrders(token);
  const lineItemIds = orders.flatMap((order) => (order.items || []).map((item) => item.id));
  const reservations = await listReservationsForLineItems(token, lineItemIds);

  const matches = findStaleReservations(orders, reservations);

  for (const match of matches) {
    console.warn(
      `Stale reservation ${match.reservation_id} on order ${match.order_id}, line_item ${match.line_item_id}, quantity ${match.quantity}. ${DRY_RUN ? "Would delete" : "Deleting"}`
    );
    if (!DRY_RUN) {
      await adminDelete(token, `/admin/reservations/${match.reservation_id}`);
    }
  }

  console.log(`Done. ${matches.length} stale reservation(s) ${DRY_RUN ? "found" : "deleted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
