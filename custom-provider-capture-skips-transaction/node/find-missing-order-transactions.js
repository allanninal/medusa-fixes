/**
 * Find Medusa v2 orders where a custom payment provider returned "captured"
 * straight from authorizePayment, skipping the order transaction that the
 * normal capturePaymentWorkflow would have written with addOrderTransactionStep.
 *
 * Because order.summary.paid_total is computed purely from OrderTransaction
 * rows, not from Payment.amount or Payment.captured_at, these orders look
 * outstanding even though the provider and the Payment record both agree the
 * money was captured. This lists orders and payments, flags the mismatch, and
 * in DRY_RUN=false mode reports the exact medusa exec command to run to write
 * the missing transaction. Multiple payments, partial captures, or prior
 * refunds on an order are always flagged for manual review, never auto-repaired.
 *
 * Guide: https://www.allanninal.dev/medusa/custom-provider-capture-skips-transaction/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORDERS_FIELDS =
  "id,display_id,currency_code,summary.paid_total," +
  "summary.transaction_total,summary.current_order_total," +
  "*payment_collections.payments";

/**
 * Pure decision function. No I/O.
 *
 * order: { id, currencyCode, paidTotal }
 * payments: [{ id, amount, capturedAt, canceledAt }, ...]
 * existingTransactionRefs: Set of payment ids already covered by an OrderTransaction
 *
 * Returns { action: "create_transaction" | "flag_ambiguous" | "noop",
 *           orderId, missingAmount, paymentId }
 *
 * Logic:
 *   1. capturedPayments = payments with capturedAt set and canceledAt unset.
 *      If there are none, return "noop".
 *   2. expectedCaptured = sum of captured payment amounts.
 *   3. If there is more than one captured payment, or the existing reference
 *      set partially covers some but not all captured payments, return
 *      "flag_ambiguous" since it is unsafe to auto-repair.
 *   4. If there is exactly one captured payment, it is missing from
 *      existingTransactionRefs, and paidTotal is less than expectedCaptured,
 *      return "create_transaction" with the missing amount and payment id.
 *   5. Otherwise return "noop".
 */
export function decideOrderTransactionRepair(order, payments, existingTransactionRefs) {
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
    const decision = decideOrderTransactionRepair(
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
    `Done. ${toCreate} order(s) ${DRY_RUN ? "need" : "were repaired for"} a missing transaction, ${toFlag} order(s) flagged for manual review.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
