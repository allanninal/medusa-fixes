/**
 * Flag Medusa v2 orders whose summary reports a phantom overpayment because
 * tax_total was left out of the summary's own totals math. order.total is
 * computed correctly as subtotal + shipping_total + tax_total minus discounts,
 * but summary.accounting_total and the pending_difference built on top of it
 * are computed from subtotal + shipping_total alone (see medusajs/medusa#13405).
 * A fully paid, tax-inclusive order therefore looks overpaid by exactly the
 * tax amount, and anything wired to pending_difference can issue a bogus
 * refund for money nobody actually overpaid. This script only flags the
 * divergence, and if a refund already matched the missing tax it flags that
 * too, gated behind DRY_RUN. It never issues a refund or a recharge. Safe to
 * run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/order-summary-tax-excluded-bogus-refund/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

const ORDER_FIELDS =
  "id,display_id,total,tax_total,subtotal,shipping_total," +
  "summary.accounting_total,summary.current_order_total,summary.pending_difference," +
  "summary.paid_total,summary.transaction_total,summary.refunded_total";

export function detectTaxDroppedFromSummary(order, epsilon = EPSILON) {
  // Pure: no I/O. order = { total, tax_total,
  // summary: { accounting_total, current_order_total, pending_difference, paid_total } }
  const { summary } = order;
  const drift = order.total - summary.accounting_total;
  const taxTotal = order.tax_total;

  const affected = taxTotal > 0 && Math.abs(drift - taxTotal) <= epsilon;
  const correctedPendingDifference = order.total - summary.paid_total;

  return { affected, drift, correctedPendingDifference };
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
  if (!res.ok) throw new Error(`Medusa ${path} ${res.status}`);
  return res.json();
}

async function adminPost(token, path, jsonBody) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(jsonBody),
  });
  if (!res.ok) throw new Error(`Medusa ${path} ${res.status}`);
  return res.json();
}

async function alreadyRefundedTax(orderId, taxTotal, token, epsilon = EPSILON) {
  const data = await adminGet(token, `/admin/orders/${orderId}/payment-collections`, {
    fields: "id,status,*payments,*payments.refunds",
  });
  for (const collection of data.payment_collections || []) {
    for (const payment of collection.payments || []) {
      for (const refund of payment.refunds || []) {
        if (Math.abs((refund.amount || 0) - taxTotal) <= epsilon) return true;
      }
    }
  }
  return false;
}

async function flagOrder(orderId, taxTotal, token) {
  await adminPost(token, `/admin/orders/${orderId}`, {
    metadata: { flagged_tax_refund_drift: true, expected_manual_recharge: taxTotal },
  });
}

async function listOrdersWithSummary(token) {
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

export async function run() {
  const token = await getAdminToken();
  const rawOrders = await listOrdersWithSummary(token);

  const report = {};
  let flagged = 0;
  for (const rawOrder of rawOrders) {
    const outcome = detectTaxDroppedFromSummary(rawOrder);
    if (!outcome.affected) continue;

    const orderId = rawOrder.id;
    report[orderId] = {
      correct_total: rawOrder.total,
      buggy_accounting_total: rawOrder.summary.accounting_total,
      drift: rawOrder.tax_total,
    };

    const alreadyRefunded = await alreadyRefundedTax(orderId, rawOrder.tax_total, token);
    flagged++;
    console.warn(
      `Order ${rawOrder.display_id || orderId} tax dropped from summary: ` +
        `correct_total=${rawOrder.total} buggy_accounting_total=${rawOrder.summary.accounting_total} ` +
        `drift=${outcome.drift} corrected_pending_difference=${outcome.correctedPendingDifference} ` +
        `already_refunded=${alreadyRefunded}. ` +
        `${DRY_RUN ? "would flag for review" : "flagging for review"}`
    );
    if (alreadyRefunded && !DRY_RUN) await flagOrder(orderId, rawOrder.tax_total, token);
  }

  console.log(
    `Done. ${flagged} order(s) with tax dropped from the summary flagged for manual review. ` +
      `No refund or recharge was issued by this script.`
  );
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
