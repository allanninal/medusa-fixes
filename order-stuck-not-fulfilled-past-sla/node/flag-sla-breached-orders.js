/**
 * Flag Medusa orders that are paid but still not fulfilled past your SLA.
 *
 * In Medusa v2, placing an order and fulfilling an order are decoupled. Capturing
 * a payment only updates payment_status. Nothing forces a fulfillment to be
 * created, so an order can sit with fulfillment_status "not_fulfilled" (or
 * "partially_fulfilled") indefinitely if the automation that should create a
 * fulfillment, an order.placed subscriber, a scheduled job, or a warehouse
 * integration, silently fails. This is worse in production when the default
 * in-memory Event Bus and Workflow Engine modules are used instead of their
 * Redis-backed equivalents, because events and job runs do not persist across
 * process restarts or multiple instances.
 *
 * The Admin API cannot filter orders server-side by fulfillment_status or
 * payment_status, so this pages through orders and computes the SLA breach
 * client-side. It never creates a fulfillment. Picking, packing, and shipping
 * are real-world actions this script cannot safely fabricate. It only patches
 * metadata to flag a breached order for human review, and only when DRY_RUN is
 * off. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/order-stuck-not-fulfilled-past-sla/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const SLA_HOURS = Number(process.env.SLA_HOURS || 48);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const UNFULFILLED_STATUSES = new Set(["not_fulfilled", "partially_fulfilled"]);

const ORDER_FIELDS =
  "id,display_id,email,created_at,status,fulfillment_status,payment_status," +
  "*payment_collections,*fulfillments,metadata";

function isPaid(order) {
  if (order.payment_status === "captured") return true;
  const collections = order.payment_collections || [];
  if (collections.length) return collections.every((pc) => pc.status === "captured");
  return false;
}

function isUnfulfilled(order) {
  if (UNFULFILLED_STATUSES.has(order.fulfillment_status)) return true;
  return (order.fulfillments || []).length === 0;
}

/**
 * Pure decision function. No I/O.
 *
 * @param {{ status: string, payment_status: string, fulfillment_status: string,
 *   fulfillments?: Array<{ id: string }>, created_at: string,
 *   metadata?: Record<string, unknown> | null,
 *   payment_collections?: Array<{ status: string }> }} order
 * @param {number} nowMs current time in epoch milliseconds, passed in
 * @param {number} slaHours hours after which a paid, unfulfilled order is breached
 * @returns {{ breached: boolean, alreadyFlagged: boolean, ageHours: number, reason?: string }}
 */
export function evaluateOrderSla(order, nowMs, slaHours) {
  const metadata = order.metadata || {};
  const alreadyFlagged = metadata.sla_flagged === true;

  if (!order.created_at) {
    return { breached: false, alreadyFlagged, ageHours: 0, reason: "missing created_at" };
  }

  const ageHours = (nowMs - Date.parse(order.created_at)) / 3_600_000;

  if (order.status === "canceled") {
    return { breached: false, alreadyFlagged, ageHours, reason: "canceled" };
  }
  if (alreadyFlagged) {
    return { breached: false, alreadyFlagged: true, ageHours, reason: "already flagged" };
  }
  if (!isPaid(order)) {
    return { breached: false, alreadyFlagged: false, ageHours, reason: "not paid" };
  }
  if (!isUnfulfilled(order)) {
    return { breached: false, alreadyFlagged: false, ageHours, reason: "already fulfilled" };
  }
  if (ageHours <= slaHours) {
    return { breached: false, alreadyFlagged: false, ageHours, reason: "within SLA" };
  }

  return { breached: true, alreadyFlagged: false, ageHours };
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
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function adminPost(token, path, body) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function listOrders(token) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", { fields: ORDER_FIELDS, limit, offset });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

async function flagOrder(token, order, ageHours) {
  const metadata = { ...(order.metadata || {}) };
  metadata.sla_flagged = true;
  metadata.sla_flagged_at = new Date().toISOString();
  metadata.sla_breach_hours = Math.floor(ageHours);
  return adminPost(token, `/admin/orders/${order.id}`, { metadata });
}

export async function run() {
  const token = await getAdminToken();
  const nowMs = Date.now();

  let flagged = 0;
  for (const order of await listOrders(token)) {
    const result = evaluateOrderSla(order, nowMs, SLA_HOURS);
    if (!result.breached) continue;
    console.warn(
      `Order ${order.display_id} (${order.id}) breached SLA: paid but ${order.fulfillment_status} for ${result.ageHours.toFixed(1)}h. ${DRY_RUN ? "would flag" : "flagging"}`
    );
    if (!DRY_RUN) await flagOrder(token, order, result.ageHours);
    flagged++;
  }

  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to flag" : "flagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
