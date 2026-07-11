/**
 * Trace Medusa reservations back to the orders they belong to.
 *
 * Medusa v2 deliberately decouples the Inventory module from the Order module.
 * ReservationItem stores only a bare line_item_id string, not a real relation, and
 * there is no module link between ReservationItem and the Order module, so the
 * Admin API and dashboard can never show which order a reservation is for. This
 * lists reservations and orders, builds a line item to order lookup that stands in
 * for the Order module's own OrderItem join, and reports every reservation as
 * traced, orphaned, or not order backed. The only write is optional enrichment:
 * stamping the resolved order id into a traced reservation's own metadata.
 * Run on a schedule, or on demand. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/reservation-missing-order-id/
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const REPORT_PATH = process.env.REPORT_PATH || "reservation_trace_report.csv";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure decision function. No I/O.
 *
 * Build a lookup: order line-item id -> order id, by walking each order's items[]
 * (this stands in for the real OrderItem join: Order 1--* OrderItem *--1 OrderLineItem).
 *
 * @param {{ id: string, line_item_id: string | null, inventory_item_id: string, quantity: number }[]} reservations
 * @param {{ id: string, items: { id: string }[] }[]} orders
 * @returns {{ reservation_id: string, order_id: string | null, status: "traced" | "orphaned_line_item" | "no_line_item" }[]}
 */
export function traceReservationsToOrders(reservations, orders) {
  const lineItemToOrder = new Map();
  for (const order of orders) {
    for (const item of order.items) {
      lineItemToOrder.set(item.id, order.id);
    }
  }

  return reservations.map((r) => {
    if (!r.line_item_id) {
      return { reservation_id: r.id, order_id: null, status: "no_line_item" };
    }
    const orderId = lineItemToOrder.get(r.line_item_id);
    if (!orderId) {
      return { reservation_id: r.id, order_id: null, status: "orphaned_line_item" };
    }
    return { reservation_id: r.id, order_id: orderId, status: "traced" };
  });
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

async function adminPost(token, path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST ${path}`);
  return res.json();
}

async function listReservations(token) {
  const reservations = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/reservations", {
      fields: "id,inventory_item_id,location_id,quantity,line_item_id,created_at",
      limit,
      offset,
    });
    reservations.push(...data.reservations);
    offset += limit;
    if (offset >= data.count) return reservations;
  }
}

async function listOrders(token) {
  const orders = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,*items",
      limit,
      offset,
    });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

async function stampResolvedOrderId(token, reservationId, orderId) {
  return adminPost(token, `/admin/reservations/${reservationId}`, {
    metadata: { resolved_order_id: orderId },
  });
}

function writeReport(path, rows) {
  const header = "reservation_id,inventory_item_id,order_id,status";
  const lines = rows.map((r) =>
    [r.reservation_id, r.inventory_item_id, r.order_id || "", r.status].join(",")
  );
  writeFileSync(path, [header, ...lines].join("\n") + "\n");
}

export async function run() {
  const token = await getAdminToken();
  const reservations = await listReservations(token);
  const orders = await listOrders(token);
  const trace = traceReservationsToOrders(reservations, orders);

  const byId = new Map(reservations.map((r) => [r.id, r]));
  const reportRows = [];
  let enriched = 0;
  let orphaned = 0;
  let noLineItem = 0;

  for (const result of trace) {
    const reservation = byId.get(result.reservation_id);
    reportRows.push({
      reservation_id: result.reservation_id,
      inventory_item_id: reservation.inventory_item_id,
      order_id: result.order_id || "",
      status: result.status,
    });

    if (result.status === "traced") {
      console.log(
        `Reservation ${result.reservation_id} traced to order ${result.order_id}. ${DRY_RUN ? "would stamp metadata" : "stamping metadata"}`
      );
      if (!DRY_RUN) await stampResolvedOrderId(token, result.reservation_id, result.order_id);
      enriched++;
    } else if (result.status === "orphaned_line_item") {
      console.warn(`Reservation ${result.reservation_id} has an orphaned line_item_id, flagged for manual review.`);
      orphaned++;
    } else {
      noLineItem++;
    }
  }

  writeReport(REPORT_PATH, reportRows);
  console.log(
    `Done. ${enriched} traced (${DRY_RUN ? "would enrich" : "enriched"}), ${orphaned} orphaned, ${noLineItem} not order backed. Report written to ${REPORT_PATH}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
