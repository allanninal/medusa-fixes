/**
 * Refund Medusa payments that are wrongly blocked by a zero-outstanding order summary.
 *
 * In Medusa v2, the Admin dashboard's Refund action and most custom refund code
 * check the order's derived summary fields, paid_total, refunded_total, and
 * outstanding_amount, instead of the actual captured amount on the Payment
 * module record. When that summary is computed or cached incorrectly after a
 * capture, for example with a custom payment provider, multiple payment
 * collections, or rounding in totals recalculation, it can read
 * outstanding_amount as zero while the payment is still fully refundable, and
 * the guard throws "Order does not have an outstanding balance to refund" on a
 * perfectly legitimate refund. This lists captured, non-refunded orders with
 * their payments expanded, computes the true refundable amount as
 * payment.amount minus payment.amount_refunded straight from the Payment
 * module, re-confirms it right before writing, and calls the refund route
 * directly, bypassing the unreliable order-summary gate.
 * Run on demand or on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/refund-blocked-zero-outstanding/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORDER_FIELDS =
  "id,display_id,status,summary.paid_total,summary.refunded_total," +
  "summary.transaction_total,*payment_collections,*payment_collections.payments";

function toDecimal(value) {
  return Number(value || 0);
}

function paymentsOf(order) {
  return (order.payment_collections || []).flatMap(
    (collection) => collection.payments || []
  );
}

/**
 * Pure decision function. No I/O.
 *
 * @param {{ amount: string|number, amount_refunded: string|number, captured_at: string|null }} payment
 * @param {{ transaction_total: string|number, paid_total: string|number, refunded_total: string|number }} orderSummary
 * @param {string|number} requestedAmount
 * @returns {{ allow: boolean, refundable_amount: string, reason?: string }}
 */
export function decideRefund(payment, orderSummary, requestedAmount) {
  if (payment.captured_at == null) {
    return { allow: false, refundable_amount: "0", reason: "not_captured" };
  }

  const paymentRefundable = toDecimal(payment.amount) - toDecimal(payment.amount_refunded);
  const summaryRefundable = toDecimal(orderSummary.paid_total) - toDecimal(orderSummary.refunded_total);

  // The payment ledger is the source of truth. The order summary is a
  // diagnostic signal only, never the blocking condition.
  const trueRefundable = paymentRefundable;

  if (toDecimal(requestedAmount) > trueRefundable) {
    return { allow: false, refundable_amount: String(trueRefundable), reason: "exceeds_refundable" };
  }

  if (summaryRefundable <= 0 && paymentRefundable > 0) {
    return {
      allow: true,
      refundable_amount: String(trueRefundable),
      reason: "summary_outstanding_zero_but_payment_captured",
    };
  }

  return { allow: true, refundable_amount: String(trueRefundable) };
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

async function listCapturedOrders(token) {
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

async function refetchPayment(token, paymentId) {
  const data = await adminGet(token, `/admin/payments/${paymentId}`, {
    fields: "id,amount,amount_refunded,captured_at,*payment_collection",
  });
  return data.payment;
}

async function refundPayment(token, paymentId, amount) {
  const payment = await refetchPayment(token, paymentId);
  if (payment.captured_at == null) {
    throw new Error(`payment ${paymentId} is not captured, refusing to refund`);
  }
  if (toDecimal(payment.amount_refunded) + toDecimal(amount) > toDecimal(payment.amount)) {
    throw new Error(`payment ${paymentId} refund would exceed captured amount`);
  }
  return adminPost(token, `/admin/payments/${paymentId}/refund`, { amount });
}

async function getOrderRefundedTotal(token, orderId) {
  const data = await adminGet(token, `/admin/orders/${orderId}`, {
    fields: "summary.refunded_total,*payment_collections.payments",
  });
  return data.order.summary.refunded_total;
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listCapturedOrders(token);

  let refunded = 0;
  let skipped = 0;
  for (const order of orders) {
    const summary = order.summary || {};
    for (const payment of paymentsOf(order)) {
      const paymentRefundable = toDecimal(payment.amount) - toDecimal(payment.amount_refunded);
      if (paymentRefundable <= 0) continue;

      const outcome = decideRefund(payment, summary, paymentRefundable);
      const label = order.display_id || order.id;

      if (!outcome.allow) {
        console.log(`Order ${label} payment ${payment.id} not refunded: ${outcome.reason}`);
        skipped++;
        continue;
      }

      if (outcome.reason === "summary_outstanding_zero_but_payment_captured") {
        console.warn(
          `Order ${label} payment ${payment.id}: summary reads zero outstanding but payment is captured and refundable=${outcome.refundable_amount}. ${DRY_RUN ? "would refund" : "refunding"}`
        );
      } else {
        console.log(
          `Order ${label} payment ${payment.id} refundable=${outcome.refundable_amount}. ${DRY_RUN ? "would refund" : "refunding"}`
        );
      }

      if (!DRY_RUN) {
        const before = summary.refunded_total;
        await refundPayment(token, payment.id, outcome.refundable_amount);
        const after = await getOrderRefundedTotal(token, order.id);
        console.log(`  order ${order.id} summary.refunded_total before=${before} after=${after}`);
      }

      refunded++;
    }
  }

  console.log(
    `Done. ${refunded} payment(s) ${DRY_RUN ? "to refund" : "refunded"}, ${skipped} skipped.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
