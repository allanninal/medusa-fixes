/**
 * Release Medusa reservations orphaned by abandoned or cancelled carts.
 *
 * When stock is reserved for a cart, Medusa creates a ReservationItem linked to a
 * line_item_id, inventory_item_id, and location_id. There is no cart cancel workflow
 * that reliably deletes that reservation, and ReservationItem has no cart_id field to
 * join back to, so an abandoned, timed out, or manually voided cart leaves the row
 * behind. This lists reservations, resolves each line_item_id against real orders,
 * and deletes only the ones that are a true orphan or tied to a canceled order, after
 * an age gate so an in-flight checkout is never touched.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/stuck-reservations-after-cancelled-carts/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const STALE_AFTER_HOURS = Number(process.env.STALE_AFTER_HOURS || 24);
const STALE_AFTER_MS = STALE_AFTER_HOURS * 3600 * 1000;
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, line_item_id: string | null, created_at: string }} reservation
 * @param {Map<string, { orderId: string, orderStatus: string }>} orderLineItemIndex
 * @param {Date} now
 * @param {number} staleAfterMs
 * @returns {"keep" | "stale_orphan" | "stale_canceled_order"}
 *
 * - "keep": there is no line_item_id, the reservation is younger than
 *   staleAfterMs, or the matched order's status is active (not "canceled").
 * - "stale_orphan": line_item_id has no matching order at all (the cart was
 *   never completed into an order).
 * - "stale_canceled_order": line_item_id matches an order whose status is
 *   "canceled".
 */
export function classifyReservation(reservation, orderLineItemIndex, now, staleAfterMs) {
  const lineItemId = reservation.line_item_id;
  if (!lineItemId) return "keep";

  const ageMs = now.getTime() - new Date(reservation.created_at).getTime();
  if (ageMs < staleAfterMs) return "keep";

  const match = orderLineItemIndex.get(lineItemId);
  if (!match) return "stale_orphan";
  if (match.orderStatus === "canceled") return "stale_canceled_order";
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
      fields: "id,quantity,line_item_id,inventory_item_id,location_id,created_at,*inventory_item",
      limit,
      offset,
    });
    reservations.push(...data.reservations);
    offset += limit;
    if (offset >= data.count) return reservations;
  }
}

async function buildOrderLineItemIndex(token) {
  const index = new Map();
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,status,*items",
      limit,
      offset,
    });
    for (const order of data.orders) {
      for (const item of order.items || []) {
        index.set(item.id, { orderId: order.id, orderStatus: order.status });
      }
    }
    offset += limit;
    if (offset >= data.count) return index;
  }
}

async function getLocationLevel(token, inventoryItemId, locationId) {
  const data = await adminGet(token, `/admin/inventory-items/${inventoryItemId}/location-levels`, {
    location_id: locationId,
  });
  const levels = data.inventory_levels || [];
  return levels[0] || null;
}

export async function run() {
  const token = await getAdminToken();
  const reservations = await listReservations(token);
  const orderLineItemIndex = await buildOrderLineItemIndex(token);
  const now = new Date();

  let released = 0;
  for (const reservation of reservations) {
    const outcome = classifyReservation(reservation, orderLineItemIndex, now, STALE_AFTER_MS);
    if (outcome === "keep") continue;

    const before = await getLocationLevel(token, reservation.inventory_item_id, reservation.location_id);
    const beforeReserved = before ? before.reserved_quantity : undefined;

    console.warn(
      `Reservation ${reservation.id} classified as ${outcome}. inventory_item_id=${reservation.inventory_item_id} location_id=${reservation.location_id} quantity=${reservation.quantity}. ${DRY_RUN ? "Would delete" : "Deleting"}`
    );

    if (!DRY_RUN) {
      await adminDelete(token, `/admin/reservations/${reservation.id}`);
      const after = await getLocationLevel(token, reservation.inventory_item_id, reservation.location_id);
      const afterReserved = after ? after.reserved_quantity : undefined;
      const expected = beforeReserved !== undefined ? beforeReserved - reservation.quantity : undefined;
      if (expected !== undefined && afterReserved !== expected) {
        console.warn(
          `  reserved_quantity did not drop as expected for ${reservation.inventory_item_id}: before=${beforeReserved} after=${afterReserved} expected=${expected}`
        );
      } else {
        console.log(`  reserved_quantity confirmed: before=${beforeReserved} after=${afterReserved}`);
      }
    }

    released++;
  }

  console.log(`Done. ${released} reservation(s) ${DRY_RUN ? "to release" : "released"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
