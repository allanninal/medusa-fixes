/**
 * Find Medusa v2 orders that received more than one order confirmation
 * notification because order.placed fired, or was acted on, more than once.
 *
 * The usual cause is a leftover workaround subscriber that manually called
 * capturePaymentWorkflow to patch an old payment-status bug (Medusa issues
 * #11766 and #13301), left running unconditionally after Medusa v2.11.1
 * fixed those bugs upstream. This script only reads orders and
 * notifications, and only ever reports, DRY_RUN=true or not, because
 * Notification records are an audit trail and must never be resent or
 * deleted automatically. Repairing the leftover subscriber file (deleting
 * or version-gating the src/subscribers file that still calls
 * capturePaymentWorkflow on order.placed) is a separate, code-level step
 * that belongs in your own migration/cleanup script, guarded by its own
 * DRY_RUN flag, per the Medusa docs on the filesystem-based subscriber
 * model: https://docs.medusajs.com/learn/fundamentals/events-and-subscribers
 *
 * Guide: https://www.allanninal.dev/medusa/duplicate-emails-from-leftover-workaround/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const WINDOW_MS = Number(process.env.DUPLICATE_WINDOW_MS || 60000);
const ORDER_LIMIT = Number(process.env.ORDER_LIMIT || 100);

const ORDER_FIELDS = "id,display_id,email,created_at";
const NOTIFICATION_FIELDS = "id,to,resource_id,resource_type,created_at,data";

export function findDuplicateNotifications(notifications, windowMs = 60000) {
  // Pure: no I/O. notifications is a plain array already fetched.
  //
  // Group order-related notifications by resource_id (order_id), sort by
  // created_at, then cluster consecutive sends to the same recipient within
  // `windowMs` of each other. Any cluster with size > 1 is a duplicate-send
  // incident caused by order.placed firing more than once for the same
  // order (e.g. a leftover re-emitting subscriber). Returns one entry per
  // order_id that has at least one duplicate cluster, with the full set of
  // notification ids involved in that cluster for downstream reporting.
  const byOrder = new Map();
  for (const n of notifications) {
    if (n.resource_type !== "order") continue;
    if (!byOrder.has(n.resource_id)) byOrder.set(n.resource_id, []);
    byOrder.get(n.resource_id).push(n);
  }

  const results = [];
  for (const [orderId, group] of byOrder) {
    group.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const clusters = [];
    let cluster = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const cur = group[i];
      const sameRecipient = prev.to === cur.to;
      const gapMs = Date.parse(cur.created_at) - Date.parse(prev.created_at);
      if (sameRecipient && gapMs <= windowMs) {
        cluster.push(cur);
      } else {
        clusters.push(cluster);
        cluster = [cur];
      }
    }
    clusters.push(cluster);

    for (const c of clusters) {
      if (c.length > 1) {
        results.push({
          order_id: orderId,
          count: c.length,
          notification_ids: c.map((n) => n.id),
        });
      }
    }
  }
  return results;
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function listRecentOrders(token, limit = ORDER_LIMIT) {
  const res = await fetch(
    `${BASE_URL}/admin/orders?fields=${ORDER_FIELDS}&limit=${limit}&order=-created_at`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.orders;
}

async function listNotificationsForOrder(token, orderId) {
  const res = await fetch(
    `${BASE_URL}/admin/notifications?resource_id=${orderId}&fields=${NOTIFICATION_FIELDS}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.notifications;
}

export async function run() {
  const token = await getToken();
  const orders = await listRecentOrders(token);
  const ordersById = new Map(orders.map((o) => [o.id, o]));

  const allNotifications = [];
  for (const order of orders) {
    allNotifications.push(...(await listNotificationsForOrder(token, order.id)));
  }

  const duplicates = findDuplicateNotifications(allNotifications, WINDOW_MS);

  if (duplicates.length === 0) {
    console.log(`No duplicate confirmation notifications across ${orders.length} order(s).`);
    return;
  }

  for (const dup of duplicates) {
    const order = ordersById.get(dup.order_id) || {};
    console.warn(
      `DRY_RUN report: order ${dup.order_id} (display_id=${order.display_id}) got ${dup.count} confirmation notifications. ids=${JSON.stringify(dup.notification_ids)}`
    );
  }

  console.log(
    `Done. ${duplicates.length} order(s) with duplicate confirmation sends. Report only, DRY_RUN=${DRY_RUN}. ` +
    "No notification was resent or deleted. The code fix is removing or gating the leftover " +
    "order.placed subscriber that calls capturePaymentWorkflow."
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
