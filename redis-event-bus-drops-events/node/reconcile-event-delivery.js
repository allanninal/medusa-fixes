/**
 * Find Medusa v2 orders whose order.placed event never reached its
 * subscriber because the Redis Event Bus Module (BullMQ) queued the job
 * before a worker's subscriber-loader finished, or a worker restarted,
 * autoscaled, or crashed mid-job. Classifies every order in the window as
 * delivered, delayed, or dropped by diffing against the Notification
 * module's own delivery log. Never mutates orders or notifications.
 * DRY_RUN=true only writes audit records for confirmed drops. Re-emitting
 * through the workflow engine is manual, opt-in, and gated behind an
 * explicit confirmation list built by a human from the audit output.
 *
 * Guide: https://www.allanninal.dev/medusa/redis-event-bus-drops-events/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 24);
const DELAY_THRESHOLD_MS = Number(process.env.DELAY_THRESHOLD_MS || 60000);
// Comma-separated order_id values a human has confirmed should be re-emitted.
const CONFIRMED_REEMIT_IDS = new Set(
  (process.env.CONFIRMED_REEMIT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean)
);

const ORDER_FIELDS = "id,display_id,status,created_at,*fulfillments";
const NOTIFICATION_FIELDS = "id,to,channel,template,trigger_type,resource_id,resource_type,event_name,original_notification_id,created_at";

function toMs(iso) {
  return Date.parse(iso);
}

export function diffEventDelivery(orders, notifications, windowStart, windowEnd, delayThresholdMs = 60000) {
  // Pure: no I/O. orders and notifications are plain arrays already fetched.
  //
  // For each order, finds the earliest notification with resource_type "order",
  // matching resource_id, and event_name "order.placed". No match means the
  // status is "dropped" (delay_ms is null). A match means "delayed" if the gap
  // between order.created_at and notification.created_at exceeds
  // delayThresholdMs, otherwise "delivered".
  const byOrder = new Map();
  for (const n of notifications) {
    if (n.resource_type !== "order" || n.event_name !== "order.placed") continue;
    const ts = toMs(n.created_at);
    const existing = byOrder.get(n.resource_id);
    if (existing === undefined || ts < existing) byOrder.set(n.resource_id, ts);
  }

  return orders.map((order) => {
    const createdMs = toMs(order.created_at);
    const matchMs = byOrder.get(order.id);
    if (matchMs === undefined) {
      return { order_id: order.id, status: "dropped", delay_ms: null };
    }
    const delayMs = matchMs - createdMs;
    const status = delayMs > delayThresholdMs ? "delayed" : "delivered";
    return { order_id: order.id, status, delay_ms: delayMs };
  });
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listOrdersSince(sdk, windowStart, limit = 200) {
  const out = [];
  let offset = 0;
  while (true) {
    const body = await sdk.admin.order.list({
      "created_at[$gte]": windowStart,
      fields: ORDER_FIELDS,
      limit,
      offset,
    });
    out.push(...body.orders);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function listNotificationsSince(sdk, windowStart, limit = 200) {
  const out = [];
  let offset = 0;
  while (true) {
    const body = await sdk.client.fetch("/admin/notifications", {
      method: "GET",
      query: { "created_at[$gte]": windowStart, fields: NOTIFICATION_FIELDS, limit, offset },
    });
    out.push(...body.notifications);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

function writeAuditRecord(orderId, displayId, windowStart, windowEnd, elapsedMs) {
  const record = {
    order_id: orderId,
    display_id: displayId,
    expected_event: "order.placed",
    window_start: windowStart,
    window_end: windowEnd,
    elapsed_ms_since_created: elapsedMs,
  };
  console.warn("DROPPED", record);
  return record;
}

async function reemitOrderPlaced(sdk, orderId) {
  // Manual, opt-in only. Re-triggers every subscriber attached to order.placed.
  //
  // Assumes a small custom workflow named reemit-order-placed is registered in
  // the Medusa app that calls emitEventStep({ eventName: "order.placed",
  // data: { id: order.id } }) from @medusajs/medusa/core-flows.
  return sdk.client.fetch("/admin/workflows/reemit-order-placed/run", {
    method: "POST",
    body: { input: { order_id: orderId } },
  });
}

export async function run() {
  const sdk = await login();
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const windowEnd = now.toISOString();

  const orders = await listOrdersSince(sdk, windowStart);
  const notifications = await listNotificationsSince(sdk, windowStart);
  const byId = new Map(orders.map((o) => [o.id, o]));

  const results = diffEventDelivery(orders, notifications, windowStart, windowEnd, DELAY_THRESHOLD_MS);
  const dropped = results.filter((r) => r.status === "dropped");
  const delayed = results.filter((r) => r.status === "delayed");

  console.log(
    `Window ${windowStart} to ${windowEnd}: ${orders.length} order(s), ${results.length - delayed.length - dropped.length} delivered, ${delayed.length} delayed, ${dropped.length} dropped.`
  );

  for (const item of dropped) {
    const order = byId.get(item.order_id);
    const elapsedMs = toMs(windowEnd) - toMs(order.created_at);
    writeAuditRecord(order.id, order.display_id, windowStart, windowEnd, elapsedMs);
  }

  if (!DRY_RUN) {
    for (const item of dropped) {
      if (!CONFIRMED_REEMIT_IDS.has(item.order_id)) {
        console.log(`Order ${item.order_id} dropped but not on the confirmed re-emit list. Skipping.`);
        continue;
      }
      console.warn(`Order ${item.order_id}: re-emitting order.placed via the workflow engine.`);
      await reemitOrderPlaced(sdk, item.order_id);
    }
  }

  console.log(`Done. ${dropped.length} dropped order(s) ${DRY_RUN ? "audited" : "processed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
