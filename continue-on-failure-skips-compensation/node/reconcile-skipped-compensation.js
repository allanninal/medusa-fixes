/**
 * Reconcile Medusa orders left partial by a continueOnPermanentFailure step.
 *
 * .config({ continueOnPermanentFailure: true }) opts a step out of the saga's rollback
 * contract. Per Medusa's docs, the compensation function of the flagged step will not
 * be called, and the workflow keeps running subsequent steps as if nothing happened.
 * If that step already committed a side effect, an order, a captured payment, or a
 * reservation, and a later step then fails and triggers a rollback, the orchestrator
 * still does not retroactively undo the flagged step's work (PR #12027, issue #11266).
 *
 * This lists recent orders with payments and fulfillments expanded, classifies each
 * one with a pure function, and reports every orphan as a structured record for a
 * human to triage. The only guarded write is deleting a dangling reservation that has
 * no live order line. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/continue-on-failure-skips-compensation/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const SINCE_HOURS = Number(process.env.SINCE_HOURS || 24);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CAPTURED_STATUSES = new Set(["captured", "authorized"]);
const STUCK_FULFILLMENT_STATUSES = new Set(["not_fulfilled"]);
const DELETABLE = new Set(["orphaned_reservation_no_order_line"]);

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, payment_status: string, fulfillment_status: string, payments: {status:string}[], fulfillments: unknown[], items?: unknown[] }} order
 * @param {{ action: string, handlerType: "invoke" | "compensate" }[]} failedSteps
 * @returns {"orphaned_payment_no_fulfillment" | "orphaned_reservation_no_order_line" | "ok"}
 */
export function classifyOrphan(order, failedSteps) {
  const hasContinueOnFailure = failedSteps.some(
    (s) => s.handlerType === "invoke" && (s.action || "").includes("continueOnPermanentFailure")
  );

  const paymentCommitted = CAPTURED_STATUSES.has(order.payment_status) && (order.payments || []).length > 0;
  const fulfillmentMissing =
    STUCK_FULFILLMENT_STATUSES.has(order.fulfillment_status) && (order.fulfillments || []).length === 0;
  if (paymentCommitted && fulfillmentMissing && hasContinueOnFailure) {
    return "orphaned_payment_no_fulfillment";
  }

  const hasDanglingReservation = failedSteps.some(
    (s) => s.action === "reserveInventoryStep" && s.handlerType === "invoke"
  );
  if (hasDanglingReservation && (order.items || []).length === 0) {
    return "orphaned_reservation_no_order_line";
  }

  return "ok";
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

async function adminDelete(token, path) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on DELETE ${path}`);
  return res.json();
}

async function listRecentOrders(token, sinceIso) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,status,fulfillment_status,payment_status,*payments,*fulfillments,*items",
      "created_at[$gte]": sinceIso,
      limit,
      offset,
    });
    orders.push(...data.orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

/**
 * Placeholder hook: in a real deployment, load the failed-step trail for this
 * order's workflow transaction (for example from your own audit log of
 * { result, errors } from someWorkflow(container).run({ input, throwOnError: false })).
 * Returns [] when there is nothing on file, which classifyOrphan treats as "ok".
 */
function failedStepsForOrder(order) {
  return order._failed_steps || [];
}

export async function run() {
  const token = await getAdminToken();
  const sinceIso = new Date(Date.now() - SINCE_HOURS * 3600 * 1000).toISOString();
  const orders = await listRecentOrders(token, sinceIso);

  let reported = 0;
  let cleaned = 0;
  for (const order of orders) {
    const failedSteps = failedStepsForOrder(order);
    const outcome = classifyOrphan(order, failedSteps);
    if (outcome === "ok") continue;

    if (DELETABLE.has(outcome)) {
      const reservationId = order._dangling_reservation_id;
      console.warn(
        `Order ${order.id} classified as ${outcome}. reservation_id=${reservationId}. ${DRY_RUN ? "Would delete" : "Deleting"}`
      );
      if (!DRY_RUN && reservationId) await adminDelete(token, `/admin/reservations/${reservationId}`);
      cleaned++;
    } else {
      const record = {
        order_id: order.id,
        action: failedSteps.find((s) => s.handlerType === "invoke")?.action ?? null,
        error_message: failedSteps[0]?.message ?? null,
        classification: outcome,
        reported_at: new Date().toISOString(),
      };
      console.log(`Orphan detected: ${JSON.stringify(record)}`);
      reported++;
    }
  }

  console.log(`Done. ${reported} order(s) reported for human triage, ${cleaned} reservation(s) ${DRY_RUN ? "to delete" : "deleted"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
