/**
 * Flag, and optionally repair, Medusa v2 orders where an order-edit-triggered
 * payment collection was sized off the order's current total instead of
 * order.summary.pending_difference. createOrderPaymentCollectionWorkflow does
 * not net out prior captures recorded in payment_collections and
 * transactions, so a partially paid order that gets a price bump ends up with
 * a new collection demanding the full new total instead of just what remains
 * outstanding (see medusajs/medusa#11591, #10686, #13068). This script is
 * report-only by default. Under an explicit DRY_RUN=false, it repairs only
 * unambiguous cases: exactly one open collection, a prior capture, and
 * something genuinely owed. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/new-collection-ignores-prior-capture/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const OPEN_STATUSES = new Set(["not_paid", "awaiting"]);
const DEFAULT_EPSILON = 0.01;

const ORDER_FIELDS =
  "id,display_id,status,*summary,*payment_collections," +
  "*payment_collections.payments,*transactions";

export function reconcileOutstandingAmount(summary, openCollections, epsilon = DEFAULT_EPSILON) {
  // Pure: no I/O. summary = {currentOrderTotal, paidTotal, refundedTotal,
  // transactionTotal}, openCollections = [{id, amount, status}].
  const pendingDifference = summary.currentOrderTotal - summary.paidTotal - summary.refundedTotal;

  const candidates = openCollections.filter((c) => OPEN_STATUSES.has(c.status));
  const openTotal = candidates.reduce((sum, c) => sum + c.amount, 0);

  if (pendingDifference <= epsilon) {
    return { action: "none", correctAmount: Math.max(pendingDifference, 0), staleCollectionIds: [] };
  }

  const overSized = openTotal - pendingDifference > epsilon;
  const priorCapture = summary.paidTotal > 0;

  if (!(overSized && priorCapture)) {
    return { action: "none", correctAmount: Math.max(pendingDifference, 0), staleCollectionIds: [] };
  }

  if (candidates.length === 1) {
    return {
      action: "recreate",
      correctAmount: Math.max(pendingDifference, 0),
      staleCollectionIds: [candidates[0].id],
    };
  }

  return {
    action: "flag",
    correctAmount: Math.max(pendingDifference, 0),
    staleCollectionIds: candidates.map((c) => c.id),
  };
}

function toDecisionInput(rawOrder) {
  const summary = rawOrder.summary || {};
  const collections = rawOrder.payment_collections || [];

  const decisionSummary = {
    currentOrderTotal: summary.current_order_total || 0,
    paidTotal: summary.paid_total || 0,
    refundedTotal: summary.refunded_total || 0,
    transactionTotal: summary.transaction_total || 0,
  };
  const openCollections = collections.map((c) => ({
    id: c.id,
    amount: c.amount || 0,
    status: c.status,
  }));

  return {
    id: rawOrder.id,
    displayId: rawOrder.display_id,
    currencyCode: rawOrder.currency_code,
    summary: decisionSummary,
    openCollections,
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

async function listOrdersWithCollections(token) {
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

async function refetchPendingDifference(token, orderId) {
  const data = await adminGet(token, `/admin/orders/${orderId}`, { fields: "id,*summary" });
  return data.order.summary.pending_difference || 0;
}

async function cancelCollection(token, collectionId) {
  const res = await fetch(
    `${BACKEND_URL}/admin/payment-collections/${collectionId}/mark-as-canceled`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Medusa cancel ${res.status}`);
  return res.json();
}

async function createCollection(token, orderId, amount, currencyCode) {
  const res = await fetch(`${BACKEND_URL}/admin/payment-collections`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId, amount, currency_code: currencyCode }),
  });
  if (!res.ok) throw new Error(`Medusa create-collection ${res.status}`);
  return res.json();
}

export async function run() {
  const token = await getAdminToken();
  const rawOrders = await listOrdersWithCollections(token);

  let flagged = 0;
  let repaired = 0;
  for (const rawOrder of rawOrders) {
    const decisionInput = toDecisionInput(rawOrder);
    const outcome = reconcileOutstandingAmount(decisionInput.summary, decisionInput.openCollections);
    if (outcome.action === "none") continue;

    const oldAmount = decisionInput.openCollections
      .filter((c) => OPEN_STATUSES.has(c.status))
      .reduce((sum, c) => sum + c.amount, 0);
    console.warn(
      `Order ${decisionInput.displayId || decisionInput.id} action=${outcome.action} ` +
        `old_amount=${oldAmount} reconciled_amount=${outcome.correctAmount} ` +
        `prior_captured_total=${decisionInput.summary.paidTotal} ` +
        `stale_collection_ids=${JSON.stringify(outcome.staleCollectionIds)}`
    );
    flagged++;

    if (outcome.action === "recreate" && !DRY_RUN) {
      const freshAmount = await refetchPendingDifference(token, decisionInput.id);
      await cancelCollection(token, outcome.staleCollectionIds[0]);
      await createCollection(token, decisionInput.id, freshAmount, decisionInput.currencyCode);
      repaired++;
    }
  }

  console.log(
    `Done. ${flagged} order(s) flagged, ${repaired} repaired. ` +
      `${DRY_RUN ? "Dry run, no writes made." : "Repairs applied where unambiguous."}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
