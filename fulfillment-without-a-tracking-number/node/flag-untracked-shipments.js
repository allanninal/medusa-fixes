/**
 * Flag Medusa fulfillments that are shipped but carry no tracking number.
 *
 * In Medusa v2, a fulfillment's tracking data lives in Fulfillment.labels[], each
 * label carrying tracking_number, tracking_url, and label_url, separate from the
 * shipped_at timestamp that actually marks it as shipped. The Admin dashboard's
 * Create Shipment flow, backed by createShipmentWorkflow, has historically built
 * the shipment's labels solely from whatever was typed into that form's tracking
 * number input, discarding any labels a fulfillment provider had already
 * attached in createFulfillment(). Because tracking entry is optional, a
 * merchant can click Mark as Shipped, setting shipped_at, while labels stays
 * empty (see medusajs/medusa issue #11160, partially addressed in PR #11775).
 *
 * There is no legitimate value this script could invent for a missing tracking
 * number, so this only flags and reports. The only write it will ever make is
 * attaching a real label a human has already obtained from the carrier or
 * fulfillment provider, and only when DRY_RUN is off. Run on a schedule. Safe to
 * run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/fulfillment-without-a-tracking-number/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORDER_FIELDS = "id,display_id,email,*fulfillments,*fulfillments.labels";

/**
 * Pure decision function. No I/O.
 *
 * A fulfillment is "shipped without tracking" iff:
 *   1. shipped_at is set (truthy) -> it has actually been marked shipped
 *   2. canceled_at is NOT set -> ignore canceled fulfillments (irrelevant once canceled)
 *   3. labels is missing/empty OR every label has a blank tracking_number
 *
 * @param {Array<{ id: string, shipped_at: string | null, canceled_at: string | null,
 *   labels?: Array<{ tracking_number?: string | null }> }>} fulfillments
 * @returns {Array<{ id: string, reason: string }>}
 */
export function findUntrackedShipments(fulfillments) {
  return fulfillments
    .filter((f) => {
      const isShipped = !!f.shipped_at;
      const isCanceled = !!f.canceled_at;
      const hasLabels = Array.isArray(f.labels) && f.labels.length > 0;
      const hasTrackingNumber =
        hasLabels && f.labels.some((l) => !!(l.tracking_number && l.tracking_number.trim().length > 0));
      return isShipped && !isCanceled && !hasTrackingNumber;
    })
    .map((f) => ({ id: f.id, reason: "shipped_at set but no non-empty tracking_number on any label" }));
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

async function refetchFulfillment(token, orderId, fulfillmentId) {
  // Re-read directly, since list responses can omit nested labels.
  const path = `/admin/orders/${orderId}/fulfillments/${fulfillmentId}`;
  const data = await adminGet(token, path, { fields: "id,shipped_at,canceled_at,*labels" });
  return data.fulfillment;
}

/** The only legitimate corrective write. Never call this with a synthesized value.
 * Mirrors the same route the Admin dashboard's Mark as Shipped / Create Shipment
 * form calls, backed by createShipmentWorkflow.
 */
async function attachTrackingNumber(token, orderId, fulfillmentId, trackingNumber, trackingUrl, labelUrl) {
  const path = `/admin/orders/${orderId}/fulfillments/${fulfillmentId}/shipment`;
  const body = { labels: [{ tracking_number: trackingNumber, tracking_url: trackingUrl, label_url: labelUrl }] };
  return adminPost(token, path, body);
}

function toCsv(rows) {
  const header = "order_id,display_id,fulfillment_id,shipped_at,provider_id";
  const lines = rows.map((r) =>
    [r.order_id, r.display_id, r.fulfillment_id, r.shipped_at, r.provider_id].map((v) => v ?? "").join(",")
  );
  return [header, ...lines].join("\n");
}

export async function run() {
  const token = await getAdminToken();

  const rows = [];
  for (const order of await listOrders(token)) {
    const fulfillments = order.fulfillments || [];
    for (const flagged of findUntrackedShipments(fulfillments)) {
      const fulfillment = fulfillments.find((f) => f.id === flagged.id);
      // Re-read directly before flagging, since list responses can omit nested labels.
      const rechecked = await refetchFulfillment(token, order.id, fulfillment.id);
      if (findUntrackedShipments([rechecked]).length) {
        rows.push({
          order_id: order.id,
          display_id: order.display_id,
          fulfillment_id: fulfillment.id,
          shipped_at: fulfillment.shipped_at,
          provider_id: fulfillment.provider_id,
        });
        console.warn(
          `Order ${order.display_id} fulfillment ${fulfillment.id} shipped with no tracking number. ${DRY_RUN ? "would report" : "reporting"}`
        );
      }
    }
  }

  const report = toCsv(rows);
  console.log(`Done. ${rows.length} fulfillment(s) shipped without tracking.`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
