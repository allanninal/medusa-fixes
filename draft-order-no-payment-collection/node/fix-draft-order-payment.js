/**
 * Find Medusa v2 draft orders that cannot get a payment collection through
 * the cart-centric store route, because a draft order never has a cart_id.
 * DRY_RUN=true (default) only reports the affected draft orders. Only when
 * DRY_RUN=false does it create the payment collection through the
 * order-linked workflow and mark it paid.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DRAFT_ORDER_FIELDS = "id,display_id,status,*summary,*payment_collections";

export function decideDraftOrderPaymentAction(order) {
  // Pure: no I/O. order has isDraftOrder, status, hasCartId,
  // paymentCollections, pendingDifference.
  if (!order.isDraftOrder) return "OK";
  if (order.status === "completed") return "OK";

  const hasCollection = order.paymentCollections.length > 0;
  if (!hasCollection && order.pendingDifference > 0) {
    // Draft orders never have a real cart_id, so the cart-based
    // payment-collection creation path is structurally inapplicable;
    // route to the order-linked workflow instead of flagging a false
    // "missing cart" bug.
    return order.hasCartId ? "NEEDS_ORDER_PAYMENT_COLLECTION" : "FLAG_STUCK_NO_PAYMENT";
  }

  return "OK";
}

function toDecisionInput(rawOrder) {
  const summary = rawOrder.summary || {};
  return {
    isDraftOrder: true,
    status: rawOrder.status,
    hasCartId: false,
    paymentCollections: rawOrder.payment_collections || [],
    pendingDifference: Number(summary.pending_difference || 0),
  };
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

async function listDraftOrders(token) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const res = await fetch(
      `${BASE_URL}/admin/draft-orders?fields=${encodeURIComponent(DRAFT_ORDER_FIELDS)}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Medusa ${res.status}`);
    const body = await res.json();
    out.push(...body.draft_orders);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function createOrderPaymentCollection(token, orderId) {
  const res = await fetch(`${BASE_URL}/admin/draft-orders/${orderId}/payment-collections`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.payment_collection;
}

async function markPaymentCollectionPaid(token, paymentCollectionId, orderId) {
  const res = await fetch(
    `${BASE_URL}/admin/payment-collections/${paymentCollectionId}/mark-as-paid`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId }),
    }
  );
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getToken();
  const draftOrders = await listDraftOrders(token);

  const flagged = draftOrders.filter(
    (rawOrder) => decideDraftOrderPaymentAction(toDecisionInput(rawOrder)) === "FLAG_STUCK_NO_PAYMENT"
  );

  if (flagged.length === 0) {
    console.log(`No stuck draft orders found across ${draftOrders.length} draft order(s).`);
    return;
  }

  for (const order of flagged) {
    const pending = order.summary?.pending_difference;
    console.warn(
      `Draft order ${order.id} (display #${order.display_id}): no payment collection, pending_difference=${pending}. ${DRY_RUN ? "Would create order-linked payment collection and mark paid" : "Repairing"}`
    );
    if (!DRY_RUN) {
      const collection = await createOrderPaymentCollection(token, order.id);
      await markPaymentCollectionPaid(token, collection.id, order.id);
    }
  }

  console.log(`Done. ${flagged.length} draft order(s) ${DRY_RUN ? "to repair" : "repaired"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
