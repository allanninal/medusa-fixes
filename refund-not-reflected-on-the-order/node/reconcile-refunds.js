/**
 * Reconcile Medusa refunds that never reached the order's summary.
 *
 * In Medusa v2, orders and payments are separate modules joined only through
 * module links. order.summary (paid_total, refunded_total, accounting_total) is
 * a cached snapshot that only recomputes when a refund runs through
 * refundPaymentsWorkflow. A refund recorded directly on the Payment module, by a
 * custom payment provider or a webhook outside the workflow, leaves the ledger
 * correct but the order stale. This lists orders with payments and refunds
 * expanded, flags any order where the ledger is ahead of the order, and resyncs
 * only that direction by calling the same refund route the admin Refund action
 * uses, with the exact amount already confirmed on the Payment module side.
 * Orders where the order shows more refunded than the ledger are flagged for
 * manual review, never auto-repaired.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/refund-not-reflected-on-the-order/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

const ORDER_FIELDS =
  "id,display_id,status,summary,*payment_collections," +
  "*payment_collections.payments,*payment_collections.payments.refunds";

/**
 * Pure decision function. No I/O.
 *
 * @param {{
 *   id: string,
 *   summary?: { paid_total: number, refunded_total: number,
 *              transaction_total: number, accounting_total: number },
 *   payment_collections: Array<{ status: string, payments: Array<{
 *     amount: number, captured_at: string | null,
 *     refunds: Array<{ amount: number, created_at: string }>
 *   }> }>,
 * }} order
 * @returns {{ orderId: string, needsSync: boolean, ledgerRefundedTotal: number,
 *             orderRefundedTotal: number, delta: number,
 *             reason: "refund_not_reflected" | "over_refunded_on_order" | "in_sync" }}
 */
export function decideRefundReconciliation(order) {
  const payments = (order.payment_collections || []).flatMap(
    (collection) => collection.payments || []
  );
  const ledgerRefundedTotal = payments.reduce(
    (sum, payment) =>
      sum + (payment.refunds || []).reduce((s, r) => s + (r.amount || 0), 0),
    0
  );
  const orderRefundedTotal = order.summary ? order.summary.refunded_total || 0 : 0;
  const delta = ledgerRefundedTotal - orderRefundedTotal;

  let reason;
  let needsSync;
  if (delta > EPSILON) {
    reason = "refund_not_reflected";
    needsSync = true;
  } else if (delta < -EPSILON) {
    reason = "over_refunded_on_order";
    needsSync = true;
  } else {
    reason = "in_sync";
    needsSync = false;
  }

  return {
    orderId: order.id,
    needsSync,
    ledgerRefundedTotal,
    orderRefundedTotal,
    delta,
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

async function listOrdersWithPayments(token) {
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

function firstPaymentId(order) {
  for (const collection of order.payment_collections || []) {
    for (const payment of collection.payments || []) {
      if (payment.id) return payment.id;
    }
  }
  return null;
}

async function resyncRefund(token, paymentId, delta) {
  return adminPost(token, `/admin/payments/${paymentId}/refund`, { amount: delta });
}

async function getOrderRefundedTotal(token, orderId) {
  const data = await adminGet(token, `/admin/orders/${orderId}`, {
    fields: "summary,*payment_collections.payments.refunds",
  });
  return data.order.summary.refunded_total;
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listOrdersWithPayments(token);

  let synced = 0;
  let flagged = 0;
  for (const order of orders) {
    const outcome = decideRefundReconciliation(order);
    if (!outcome.needsSync) continue;

    if (outcome.reason === "over_refunded_on_order") {
      console.warn(
        `Order ${order.display_id || order.id} over-refunded on the order side (ledger=${outcome.ledgerRefundedTotal} order=${outcome.orderRefundedTotal}). Flagging for manual review.`
      );
      flagged++;
      continue;
    }

    const paymentId = firstPaymentId(order);
    if (paymentId === null) {
      console.warn(`Order ${order.id} has a refund gap but no payment id found. Flagging.`);
      flagged++;
      continue;
    }

    console.warn(
      `Order ${order.display_id || order.id} refund not reflected: ledger=${outcome.ledgerRefundedTotal} order=${outcome.orderRefundedTotal} delta=${outcome.delta}. ${DRY_RUN ? "would resync" : "resyncing"}`
    );

    if (!DRY_RUN) {
      await resyncRefund(token, paymentId, outcome.delta);
      const confirmedTotal = await getOrderRefundedTotal(token, order.id);
      if (Math.abs(confirmedTotal - outcome.ledgerRefundedTotal) > EPSILON) {
        console.warn(
          `  order ${order.id} did not resync as expected: ledger=${outcome.ledgerRefundedTotal} order_now=${confirmedTotal}`
        );
      } else {
        console.log(`  order ${order.id} confirmed in sync: refunded_total=${confirmedTotal}`);
      }
    }

    synced++;
  }

  console.log(
    `Done. ${synced} order(s) ${DRY_RUN ? "to resync" : "resynced"}, ${flagged} order(s) flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
