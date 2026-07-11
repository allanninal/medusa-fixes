/**
 * Flag Medusa orders whose fulfillment status is stuck on Delivered after a
 * full return and refund.
 *
 * In Medusa v2, order.fulfillment_status is derived only from fulfillment
 * records, shipped and delivered quantities. Receiving a return through
 * receiveReturnWorkflow updates the Return's received quantities, and issuing
 * a refund updates the order's payment summary, but neither workflow
 * recomputes fulfillment_status. A fully returned, fully refunded order can
 * sit forever showing delivered as if the customer still has the goods. This
 * lists orders with items, fulfillments, and returns expanded, flags any
 * order where every fulfilled unit has a matching received unit on a
 * completed return and the refund covers it, and tags only those orders for
 * review. It never writes fulfillment_status directly.
 *
 * Guide: https://www.allanninal.dev/medusa/fulfillment-status-stuck-delivered/
 * Run on a schedule. Safe to run again and again.
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const REVIEW_TAG = process.env.REVIEW_TAG || "returned-and-refunded";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;
const STUCK_STATUSES = new Set(["delivered", "partially_delivered"]);

const ORDER_FIELDS = "id,display_id,fulfillment_status,summary,*items,*returns,*returns.items";

/**
 * Pure decision function. No I/O.
 *
 * @param {{
 *   id: string,
 *   fulfillment_status: string,
 *   summary: { refunded_total: number },
 *   items: Array<{ id: string, quantity: number, unit_price: number }>,
 *   returns: Array<{ status: string, items: Array<{ item_id: string, quantity: number }> }>,
 * }} order
 * @returns {{ orderId: string, isStuck: boolean, fulfilledQty: number, receivedQty: number,
 *             returnedValue: number, refundedTotal: number,
 *             reason: "stuck_delivered" | "in_progress" | "not_returned" }}
 */
export function decideFulfillmentRepair(order) {
  const items = order.items || [];
  const fulfilledQty = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  const priceByItem = new Map(items.map((item) => [item.id, item.unit_price || 0]));

  let receivedQty = 0;
  let returnedValue = 0;
  for (const ret of order.returns || []) {
    if (ret.status !== "received") continue;
    for (const line of ret.items || []) {
      const qty = line.quantity || 0;
      receivedQty += qty;
      returnedValue += qty * (priceByItem.get(line.item_id) || 0);
    }
  }

  const refundedTotal = order.summary ? order.summary.refunded_total || 0 : 0;
  const status = order.fulfillment_status;

  let reason;
  let isStuck;
  if (receivedQty <= 0) {
    reason = "not_returned";
    isStuck = false;
  } else if (receivedQty + EPSILON < fulfilledQty) {
    reason = "in_progress";
    isStuck = false;
  } else if (refundedTotal + EPSILON < returnedValue) {
    reason = "in_progress";
    isStuck = false;
  } else if (STUCK_STATUSES.has(status)) {
    reason = "stuck_delivered";
    isStuck = true;
  } else {
    reason = "not_returned";
    isStuck = false;
  }

  return {
    orderId: order.id,
    isStuck,
    fulfilledQty,
    receivedQty,
    returnedValue,
    refundedTotal,
    reason,
  };
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

async function adminPost(token, path, jsonBody) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jsonBody),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST ${path}`);
  return res.json();
}

async function listOrdersWithReturns(token) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: ORDER_FIELDS,
      limit,
      offset,
    });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

async function tagReturnedAndRefunded(token, orderId, reviewTag) {
  return adminPost(token, `/admin/orders/${orderId}`, {
    metadata: { [reviewTag]: true },
  });
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listOrdersWithReturns(token);

  let flagged = 0;
  for (const order of orders) {
    const outcome = decideFulfillmentRepair(order);
    if (!outcome.isStuck) continue;

    console.warn(
      `Order ${order.display_id || order.id} stuck on ${order.fulfillment_status} after a full return (fulfilled=${outcome.fulfilledQty} received=${outcome.receivedQty} refunded=${outcome.refundedTotal}). ${DRY_RUN ? "would tag" : "tagging"}`
    );

    if (!DRY_RUN) {
      await tagReturnedAndRefunded(token, order.id, REVIEW_TAG);
    }

    flagged++;
  }

  console.log(`Done. ${flagged} order(s) ${DRY_RUN ? "to tag" : "tagged"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
