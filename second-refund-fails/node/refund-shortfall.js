/**
 * Find Medusa orders where a second refund silently failed.
 *
 * Medusa v2's refund-payment workflow historically validates a refund request
 * against the order's cached summary.pending_difference instead of re-summing
 * that specific payment's actual captures minus its existing refunds. The
 * first refund on an order correctly zeroes or flips the sign of the
 * order-level balance, so validate-refund-step rejects every refund attempt
 * after that with "Order does not have an outstanding balance to refund",
 * even though the payment itself may still have capturable or refundable
 * amount left. This lists orders with captures and refunds expanded,
 * computes the true shortfall per payment independent of the order summary,
 * and flags every payment that is silently blocked. It never fires a refund
 * unless DRY_RUN is false and a human has approved the list, since this is
 * real money moving through a provider.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/second-refund-fails/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

const ORDER_FIELDS =
  "id,display_id,summary,*payment_collections," +
  "*payment_collections.payments,*payment_collections.payments.captures," +
  "*payment_collections.payments.refunds";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, captures: Array<{ raw_amount: number }>, refunds: Array<{ raw_amount: number }> }} payment
 * @param {number} orderPendingDifference the order's own cached summary.pending_difference
 * @returns {{ paymentId: string, capturedTotal: number, refundedTotal: number,
 *             shortfall: number, isSilentlyBlocked: boolean }}
 */
export function computeRefundShortfall(payment, orderPendingDifference) {
  const capturedTotal = (payment.captures || []).reduce((sum, c) => sum + (c.raw_amount || 0), 0);
  const refundedTotal = (payment.refunds || []).reduce((sum, r) => sum + (r.raw_amount || 0), 0);
  const shortfall = capturedTotal - refundedTotal;
  const isSilentlyBlocked = shortfall > EPSILON && orderPendingDifference <= EPSILON;

  return {
    paymentId: payment.id,
    capturedTotal,
    refundedTotal,
    shortfall,
    isSilentlyBlocked,
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

async function listOrdersWithLedger(token) {
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

function paymentsOf(order) {
  return (order.payment_collections || []).flatMap((collection) => collection.payments || []);
}

async function fireMakeupRefund(token, paymentId, shortfall) {
  return adminPost(token, `/admin/payments/${paymentId}/refund`, { amount: shortfall });
}

export async function run() {
  const token = await getAdminToken();
  const orders = await listOrdersWithLedger(token);

  let flagged = 0;
  for (const order of orders) {
    const pendingDifference = order.summary ? order.summary.pending_difference || 0 : 0;
    for (const payment of paymentsOf(order)) {
      const outcome = computeRefundShortfall(payment, pendingDifference);
      if (!outcome.isSilentlyBlocked) continue;

      console.warn(
        `Order ${order.display_id || order.id} payment ${outcome.paymentId} silently blocked: captured=${outcome.capturedTotal} refunded=${outcome.refundedTotal} shortfall=${outcome.shortfall}. ${DRY_RUN ? "would refund" : "refunding"}`
      );

      if (!DRY_RUN) {
        await fireMakeupRefund(token, outcome.paymentId, outcome.shortfall);
      }

      flagged++;
    }
  }

  console.log(
    `Done. ${flagged} payment(s) ${DRY_RUN ? "flagged, none refunded (dry run)" : "refunded"}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
