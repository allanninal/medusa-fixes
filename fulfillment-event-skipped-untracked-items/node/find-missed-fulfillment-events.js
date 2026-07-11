/**
 * Find Medusa v2 fulfillments whose order.fulfillment_created event never fired.
 *
 * createOrderFulfillmentWorkflow runs emitEventStep for order.fulfillment_created
 * near the end of its step graph, after the inventory reservation steps that only
 * touch line items whose variant has manage_inventory: true (tracked in
 * medusajs/medusa#10721). When every item on a fulfillment is untracked
 * inventory, those reservation steps have nothing to operate on, and the
 * workflow can finish before it reaches emitEventStep. The fulfillment record
 * is still created correctly, only the event, and anything that depended on
 * it like a shipment-notification email, is skipped silently.
 *
 * This is a flag/report job, not an auto-fix: it never calls
 * POST /admin/orders/{id}/fulfillments again, since that would create a
 * duplicate fulfillment. By default it only reports the order_id/fulfillment_id
 * pairs it finds. With DRY_RUN=false it re-emits order.fulfillment_created
 * through your own event bus (call this from a Medusa exec script, see the
 * guide) and then flags the fulfillment as backfilled via a metadata patch so
 * the same one is never re-emitted twice.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/fulfillment-event-skipped-untracked-items/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const BACKFILL_FLAG = "fulfillment_created_event_backfilled";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, items: { line_item_id: string }[] }} fulfillment
 * @param {Record<string, { manage_inventory: boolean }>} orderItemsByLineItemId
 * @param {Set<string>} notifiedFulfillmentIds
 * @returns {boolean}
 *
 * Returns true only when the fulfillment has no matching notification and
 * every one of its items resolves to manage_inventory false, treating a
 * missing lookup as untracked (conservative). A mixed fulfillment, or one
 * that already has a notification, returns false.
 */
export function isFulfillmentEventLikelyMissed(fulfillment, orderItemsByLineItemId, notifiedFulfillmentIds) {
  if (notifiedFulfillmentIds.has(fulfillment.id)) return false;
  const flags = fulfillment.items.map(
    (item) => orderItemsByLineItemId[item.line_item_id]?.manage_inventory ?? false
  );
  return flags.length > 0 && flags.every((flag) => flag === false);
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

async function listOrdersWithFulfillments(token) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,*fulfillments,*items,items.variant.manage_inventory,*fulfillments.items",
      order: "-created_at",
      limit,
      offset,
    });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

async function notifiedFulfillmentIds(token) {
  const ids = new Set();
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/notifications", {
      fields: "id,to,template,data",
      order: "-created_at",
      limit,
      offset,
    });
    for (const n of data.notifications) {
      const fid = n.data?.fulfillment_id;
      if (fid) ids.add(fid);
    }
    offset += limit;
    if (offset >= data.count) return ids;
  }
}

function orderItemsByLineItemId(order) {
  const result = {};
  for (const item of order.items || []) {
    result[item.id] = { manage_inventory: Boolean(item.variant?.manage_inventory) };
  }
  return result;
}

async function markBackfilled(token, orderId, fulfillmentId) {
  return adminPost(token, `/admin/orders/${orderId}/fulfillments/${fulfillmentId}`, {
    metadata: { [BACKFILL_FLAG]: true },
  });
}

function reemitFulfillmentCreated(orderId, fulfillmentId) {
  // Re-emitting through the event bus has to happen inside the Medusa
  // process, where Modules.EVENT_BUS can be resolved. Call your Medusa
  // exec script here, for example:
  //   npx medusa exec ./src/scripts/backfill-exec.js <fulfillmentId> <orderId>
  console.log(`Re-emit order.fulfillment_created for order=${orderId} fulfillment=${fulfillmentId} (run the Medusa exec script)`);
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listOrdersWithFulfillments(token);
  const notified = await notifiedFulfillmentIds(token);

  let missed = 0;
  for (const order of orders) {
    const itemsById = orderItemsByLineItemId(order);
    for (const fulfillment of order.fulfillments || []) {
      if (fulfillment.metadata?.[BACKFILL_FLAG]) continue;
      if (!isFulfillmentEventLikelyMissed(fulfillment, itemsById, notified)) continue;
      console.warn(
        `Order ${order.id} fulfillment ${fulfillment.id} likely missed order.fulfillment_created. ${DRY_RUN ? "would backfill" : "backfilling"}`
      );
      if (!DRY_RUN) {
        reemitFulfillmentCreated(order.id, fulfillment.id);
        await markBackfilled(token, order.id, fulfillment.id);
      }
      missed++;
    }
  }

  console.log(`Done. ${missed} fulfillment(s) ${DRY_RUN ? "to backfill" : "backfilled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
