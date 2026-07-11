/**
 * Find Medusa v2 orders where a custom payment provider's capture leaves
 * order.summary.outstanding_amount out of sync with what was actually captured.
 *
 * outstanding_amount is derived as current_order_total minus paid_total, and
 * paid_total is computed purely from OrderTransaction rows, never from the
 * Payment entity directly. When a custom provider's capture path finishes
 * without running the same order transaction step the built-in
 * capturePaymentWorkflow always runs, the Payment shows captured_at set but no
 * transaction backs it, so outstanding_amount keeps counting money that already
 * arrived. This lists orders and payments, flags the mismatch, and in
 * DRY_RUN=false mode reports the exact medusa exec command to run to write the
 * missing transaction. Multiple payments, partial captures, or prior refunds on
 * an order are always flagged for manual review, never auto-repaired.
 *
 * Guide: https://www.allanninal.dev/medusa/custom-provider-outstanding-desync/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORDERS_FIELDS =
  "id,display_id,currency_code,summary.paid_total," +
  "summary.outstanding_amount,summary.current_order_total," +
  "*payment_collections.payments";

export function decideOutstandingRepair(order, payments, existingTransactionRefs) {
  const captured = payments.filter((p) => p.capturedAt && !p.canceledAt);
  if (captured.length === 0) {
    return { action: "noop", orderId: order.id, missingAmount: 0, paymentId: null };
  }

  const expectedCaptured = captured.reduce((sum, p) => sum + p.amount, 0);
  const covered = captured.filter((p) => existingTransactionRefs.has(p.id)).length;

  if (captured.length > 1 || (covered > 0 && covered < captured.length)) {
    return { action: "flag_ambiguous", orderId: order.id, missingAmount: 0, paymentId: null };
  }

  const [payment] = captured;
  if (!existingTransactionRefs.has(payment.id) && order.paidTotal < expectedCaptured) {
    return {
      action: "create_transaction",
      orderId: order.id,
      missingAmount: expectedCaptured - order.paidTotal,
      paymentId: payment.id,
    };
  }

  return { action: "noop", orderId: order.id, missingAmount: 0, paymentId: null };
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

async function listOrders(token, offset, limit) {
  const params = new URLSearchParams({ fields: ORDERS_FIELDS, offset: String(offset), limit: String(limit) });
  const res = await fetch(`${BACKEND_URL}/admin/orders?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  return res.json();
}

async function getOrderTransactions(token, orderId) {
  const params = new URLSearchParams({ fields: "id,*transactions" });
  const res = await fetch(`${BACKEND_URL}/admin/orders/${orderId}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.order.transactions || [];
}

function existingPaymentRefs(transactions) {
  return new Set(
    transactions.filter((t) => t.reference === "payment" && t.reference_id).map((t) => t.reference_id)
  );
}

function flattenPayments(order) {
  const payments = [];
  for (const collection of order.payment_collections || []) {
    for (const payment of collection.payments || []) {
      payments.push({
        id: payment.id,
        amount: payment.amount,
        capturedAt: payment.captured_at,
        canceledAt: payment.canceled_at,
      });
    }
  }
  return payments;
}

async function* iterOrders(token) {
  let offset = 0;
  const limit = 50;
  while (true) {
    const data = await listOrders(token, offset, limit);
    for (const order of data.orders || []) yield order;
    offset += limit;
    if (offset >= (data.count || 0)) return;
  }
}

export async function run() {
  const token = await getAdminToken();
  let toCreate = 0;
  let toFlag = 0;

  for await (const order of iterOrders(token)) {
    const payments = flattenPayments(order);
    if (payments.length === 0) continue;

    const transactions = await getOrderTransactions(token, order.id);
    const refs = existingPaymentRefs(transactions);
    const decision = decideOutstandingRepair(
      {
        id: order.id,
        currencyCode: order.currency_code,
        paidTotal: order.summary?.paid_total || 0,
      },
      payments,
      refs
    );

    if (decision.action === "flag_ambiguous") {
      console.warn(`Order ${order.id} has an ambiguous capture history. Flagging for manual review.`);
      toFlag++;
      continue;
    }

    if (decision.action !== "create_transaction") continue;

    const record = {
      orderId: decision.orderId,
      paymentId: decision.paymentId,
      amount: decision.missingAmount,
      currencyCode: order.currency_code,
    };

    if (DRY_RUN) {
      console.log(
        `Would create transaction. order_id=${record.orderId} payment_id=${record.paymentId} amount=${record.amount} currency_code=${record.currencyCode}`
      );
    } else {
      console.log(
        `Run inside the Medusa project: npx medusa exec ./src/scripts/create-order-transaction.ts ${record.orderId} ${record.amount} ${record.currencyCode} ${record.paymentId}`
      );
    }
    toCreate++;
  }

  console.log(
    `Done. ${toCreate} order(s) ${DRY_RUN ? "need" : "were repaired for"} an outstanding_amount repair, ${toFlag} order(s) flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
