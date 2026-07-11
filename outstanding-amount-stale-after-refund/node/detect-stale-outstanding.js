/**
 * Flag Medusa v2 orders whose outstanding_amount stopped updating after the
 * first refund. outstanding_amount is a derived field on the order's summary,
 * computed by the totals module from order_transaction rows, not a value that
 * gets decremented directly. The first refund on an order inserts a new
 * transaction row and the summary recomputes correctly, but a second
 * refundPaymentsWorkflow run on the same order or payment does not insert
 * another row (see medusajs/medusa#11481), so the summary is never recomputed
 * again and outstanding_amount freezes while the payment provider keeps
 * processing more refunds. There is no safe PATCH for this field, so this
 * script only flags the divergence for a human to reconcile. It never calls
 * the refund endpoint again. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/outstanding-amount-stale-after-refund/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const EPSILON = 0.01;

const ORDER_FIELDS =
  "id,display_id,*summary,*payment_collections," +
  "*payment_collections.payments,*payment_collections.payments.refunds";

export function detectStaleOutstanding(order) {
  // Pure: no I/O. order = { total, captures: [{amount}],
  // refunds: [{id, amount, created_at}], reportedOutstanding }
  const captures = order.captures || [];
  const refunds = order.refunds || [];

  const trueOutstanding =
    order.total -
    captures.reduce((sum, c) => sum + c.amount, 0) +
    refunds.reduce((sum, r) => sum + r.amount, 0);
  const refundCount = refunds.length;
  const delta = order.reportedOutstanding - trueOutstanding;
  const affected = refundCount > 1 && Math.abs(delta) > EPSILON;

  return {
    affected,
    trueOutstanding,
    reportedOutstanding: order.reportedOutstanding,
    delta,
    refundCount,
  };
}

function toDecisionInput(rawOrder) {
  const payments = (rawOrder.payment_collections || []).flatMap(
    (collection) => collection.payments || []
  );
  const captures = payments
    .filter((p) => p.captured_at)
    .map((p) => ({ amount: p.amount || 0 }));
  const refunds = payments.flatMap((p) =>
    (p.refunds || []).map((r) => ({ id: r.id, amount: r.amount || 0, created_at: r.created_at }))
  );
  const summary = rawOrder.summary || {};

  return {
    id: rawOrder.id,
    displayId: rawOrder.display_id,
    total: summary.raw_current_order_total ?? rawOrder.total ?? 0,
    captures,
    refunds,
    reportedOutstanding: summary.outstanding_amount || 0,
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
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${path} ${res.status}`);
  return res.json();
}

async function listOrdersWithRefunds(token) {
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
  const rawOrders = await listOrdersWithRefunds(token);

  let flagged = 0;
  for (const rawOrder of rawOrders) {
    const decisionInput = toDecisionInput(rawOrder);
    const outcome = detectStaleOutstanding(decisionInput);
    if (!outcome.affected) continue;

    flagged++;
    console.warn(
      `Order ${decisionInput.displayId || decisionInput.id} stale outstanding_amount: ` +
        `reported=${outcome.reportedOutstanding} true=${outcome.trueOutstanding} ` +
        `delta=${outcome.delta} refund_count=${outcome.refundCount} ` +
        `refunds=${JSON.stringify(decisionInput.refunds)}. ` +
        `${DRY_RUN ? "would flag for review" : "flagging for review"}`
    );
  }

  console.log(
    `Done. ${flagged} order(s) with a stale outstanding_amount flagged for manual reconciliation. ` +
      `No orders were written to.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
