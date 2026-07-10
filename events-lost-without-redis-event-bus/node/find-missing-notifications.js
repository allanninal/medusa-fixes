/**
 * Find Medusa v2 orders whose expected notification, such as order.placed,
 * never fired because the default in-memory event-bus-local dropped the
 * event across processes or a restart. Never replays raw events and never
 * fabricates historical notifications. DRY_RUN=true only reports the
 * flagged orders. Safe to run again and again, because repair is guarded
 * by an idempotency check against the Notification module's own log.
 *
 * Guide: https://www.allanninal.dev/medusa/events-lost-without-redis-event-bus/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const EXPECTED_EVENT = process.env.EXPECTED_EVENT || "order.placed";
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 10);

const ORDER_FIELDS = "id,display_id,status,fulfillment_status,payment_status,created_at,*customer";

/**
 * Pure: no I/O. orders and notifications are plain arrays already fetched.
 *
 * Flags an order when it is older than graceMs and no notification row exists
 * with resource_type "order", resource_id === order.id, and
 * event_name === expectedEvent.
 */
export function findOrdersMissingNotification(orders, notifications, expectedEvent, graceMs, nowMs) {
  const notifiedIds = new Set(
    notifications
      .filter((n) => n.resource_type === "order" && n.event_name === expectedEvent)
      .map((n) => n.resource_id)
  );

  const flagged = [];
  for (const order of orders) {
    const createdMs = Date.parse(order.created_at);
    if (nowMs - createdMs > graceMs && !notifiedIds.has(order.id)) {
      flagged.push({ order_id: order.id, expected_event: expectedEvent });
    }
  }
  return flagged;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listRecentOrders(sdk, limit = 100) {
  const out = [];
  let offset = 0;
  while (true) {
    const body = await sdk.admin.order.list({
      fields: ORDER_FIELDS, limit, offset, order: "-created_at",
    });
    out.push(...body.orders);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function listNotificationsForOrder(sdk, orderId) {
  const body = await sdk.client.fetch("/admin/notifications", {
    method: "GET",
    query: { resource_id: orderId, resource_type: "order", limit: 50 },
  });
  return body.notifications;
}

async function alreadyNotified(sdk, orderId, expectedEvent) {
  const notifications = await listNotificationsForOrder(sdk, orderId);
  return notifications.some((n) => n.event_name === expectedEvent);
}

async function retriggerOrderConfirmation(sdk, orderId) {
  return sdk.client.fetch(`/admin/orders/${orderId}/resend-confirmation`, {
    method: "POST",
    body: {},
  });
}

export async function run() {
  const sdk = await login();
  const orders = await listRecentOrders(sdk);

  const allNotifications = [];
  for (const order of orders) {
    allNotifications.push(...(await listNotificationsForOrder(sdk, order.id)));
  }

  const nowMs = Date.now();
  const graceMs = GRACE_MINUTES * 60 * 1000;
  const flagged = findOrdersMissingNotification(orders, allNotifications, EXPECTED_EVENT, graceMs, nowMs);

  if (flagged.length === 0) {
    console.log(`No orders missing ${EXPECTED_EVENT} across ${orders.length} order(s).`);
    return;
  }

  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const item of flagged) {
    const order = byId.get(item.order_id);
    console.warn(
      `Order ${order.id} (display_id=${order.display_id}) missing ${item.expected_event} since ${order.created_at}. customer_email=${order.customer?.email}`
    );
  }

  if (!DRY_RUN) {
    for (const item of flagged) {
      if (await alreadyNotified(sdk, item.order_id, item.expected_event)) {
        console.log(`Order ${item.order_id} already notified since the scan ran. Skipping.`);
        continue;
      }
      console.log(`Order ${item.order_id}: re-triggering ${item.expected_event}.`);
      await retriggerOrderConfirmation(sdk, item.order_id);
    }
  }

  console.log(`Done. ${flagged.length} order(s) ${DRY_RUN ? "to review" : "processed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
