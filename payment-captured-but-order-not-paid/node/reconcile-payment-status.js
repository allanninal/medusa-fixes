/**
 * Find Medusa v2 orders where a payment was captured but the order never
 * advanced off not_paid, and repair them the safe way. Never writes
 * payment_status directly, since it is derived, not stored. DRY_RUN=true
 * only logs the order_id/payment_id pairs it would re-trigger. Safe to run
 * again and again, because re-invoking capture on an already captured
 * payment cannot double charge.
 *
 * Guide: https://www.allanninal.dev/medusa/payment-captured-but-order-not-paid/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const UNPAID_STATUSES = new Set(["not_paid", "awaiting"]);
const STALE_COLLECTION_STATUSES = new Set(["not_paid", "awaiting", "authorized"]);

const ORDER_FIELDS =
  "id,status,payment_status,*summary," +
  "*payment_collections,*payment_collections.payments," +
  "payment_collections.payments.captured_at," +
  "payment_collections.payments.captures," +
  "payment_collections.payments.captures.raw_amount";

export function detectPaymentStatusMismatch(order) {
  // Pure: no I/O. order has payment_status, summary, payment_collections.
  let totalCaptured = 0;
  let staleCollection = false;

  for (const pc of order.payment_collections || []) {
    let pcCaptured = 0;
    for (const payment of pc.payments || []) {
      for (const capture of payment.captures || []) {
        pcCaptured += capture.raw_amount?.value || 0;
      }
    }
    totalCaptured += pcCaptured;
    if (pcCaptured > 0 && STALE_COLLECTION_STATUSES.has(pc.status)) {
      staleCollection = true;
    }
  }

  const paidTotal = order.summary?.raw_paid_total?.value || 0;
  const paymentStatus = order.payment_status;

  let reason = null;
  if (totalCaptured > 0 && UNPAID_STATUSES.has(paymentStatus)) {
    reason = `captured funds exist but payment_status is still ${paymentStatus}`;
  } else if (totalCaptured > 0 && paidTotal === 0) {
    reason = "captured funds exist but summary.raw_paid_total is 0";
  } else if (staleCollection) {
    reason = "a payment_collection is captured but its own status has not advanced";
  }

  return {
    orderId: order.id,
    mismatched: reason !== null,
    reason,
  };
}

function flaggedPaymentIds(order) {
  const ids = [];
  for (const pc of order.payment_collections || []) {
    for (const payment of pc.payments || []) {
      if (payment.captured_at && payment.id) ids.push(payment.id);
    }
  }
  return ids;
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listRecentOrders(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.order.list({ fields: ORDER_FIELDS, limit, offset });
    out.push(...body.orders);
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function reinvokeCapture(sdk, paymentId) {
  return sdk.admin.payment.capture(paymentId, {});
}

async function getOrder(sdk, orderId) {
  const body = await sdk.admin.order.retrieve(orderId, { fields: ORDER_FIELDS });
  return body.order;
}

export async function run() {
  const sdk = await login();
  const orders = await listRecentOrders(sdk);

  const flagged = [];
  for (const order of orders) {
    const result = detectPaymentStatusMismatch(order);
    if (result.mismatched) flagged.push([order, result]);
  }

  if (flagged.length === 0) {
    console.log(`No payment_status mismatches found across ${orders.length} order(s).`);
    return;
  }

  for (const [order, result] of flagged) {
    const paymentIds = flaggedPaymentIds(order);
    if (paymentIds.length === 0) {
      console.warn(
        `Order ${order.id} mismatched (${result.reason}) but has no local Payment with captured_at set. Flagging to a human, not writing status.`
      );
      continue;
    }

    for (const paymentId of paymentIds) {
      console.log(
        `Order ${order.id} payment ${paymentId}: ${result.reason}. ${DRY_RUN ? "Would re-invoke capture" : "Re-invoking capture"}`
      );
      if (!DRY_RUN) await reinvokeCapture(sdk, paymentId);
    }

    if (!DRY_RUN) {
      const refreshed = await getOrder(sdk, order.id);
      const stillMismatched = detectPaymentStatusMismatch(refreshed).mismatched;
      if (stillMismatched) {
        console.warn(`Order ${order.id} still mismatched after re-invoking capture. Flagging to a human, not writing status.`);
      } else {
        console.log(`Order ${order.id} confirmed reconciled. payment_status=${refreshed.payment_status}`);
      }
    }
  }

  console.log(`Done. ${flagged.length} order(s) ${DRY_RUN ? "to reconcile" : "processed"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
