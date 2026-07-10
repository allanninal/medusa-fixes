/**
 * Reconcile Medusa reservations left behind by a workflow that never finished.
 *
 * Medusa v2 workflows are sagas: each step's rollback is opt-in through a compensation
 * function passed to createStep, so a step without one, such as createRemoteLinkStep
 * (GitHub #9844), leaves its side effect in place if a later step throws. Separately, a
 * crashed process or the in-memory Workflow Engine used in production means the saga
 * never reaches the compensating phase at all, so an already-committed reservation from
 * reserveInventoryStep stays committed while workflow_execution is stuck in a
 * non-terminal state (GitHub #9077, #12913, #11266).
 *
 * This lists reservations, resolves each line_item_id's parent order, classifies each
 * reservation with a pure function, and deletes only the unambiguous orphan cases:
 * an order that no longer resolves (404) or an order whose status is canceled.
 * Everything else is reported only. Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/workflow-left-half-done/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 10);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const DELETABLE = new Set(["orphaned_no_order", "orphaned_canceled_order"]);

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, line_item_id: string | null, created_at: string }} reservation
 * @param {{ id: string, status: string } | null} order
 * @param {string} nowIso
 * @param {number} staleMinutes
 * @returns {"orphaned_no_order" | "orphaned_canceled_order" | "stale_pending_review" | "healthy"}
 */
export function classifyReservation(reservation, order, nowIso, staleMinutes = 10) {
  if (reservation.line_item_id == null) return "healthy";

  if (order == null) return "orphaned_no_order";

  if (order.status === "canceled") return "orphaned_canceled_order";

  const ageMs = Date.parse(nowIso) - Date.parse(reservation.created_at);
  if (ageMs > staleMinutes * 60000 && !["pending", "completed"].includes(order.status)) {
    return "stale_pending_review";
  }

  return "healthy";
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

async function listReservations(token) {
  const reservations = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/reservations", {
      fields: "id,line_item_id,inventory_item_id,location_id,quantity,created_at,*line_item.order_id",
      limit,
      offset,
    });
    reservations.push(...data.reservations);
    offset += limit;
    if (offset >= data.count) return reservations;
  }
}

async function getOrderOrNull(token, orderId) {
  if (!orderId) return null;
  const res = await fetch(new URL(`${BACKEND_URL}/admin/orders/${orderId}?fields=id,status`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Medusa ${res.status} on GET /admin/orders/${orderId}`);
  const body = await res.json();
  return body.order;
}

export async function run() {
  const token = await getAdminToken();
  const reservations = await listReservations(token);
  const nowIso = new Date().toISOString();

  let deleted = 0;
  let reported = 0;
  for (const reservation of reservations) {
    const orderId = reservation.line_item?.order_id;
    const order = reservation.line_item_id ? await getOrderOrNull(token, orderId) : null;

    const outcome = classifyReservation(reservation, order, nowIso, STALE_MINUTES);
    if (outcome === "healthy") continue;

    if (DELETABLE.has(outcome)) {
      console.warn(
        `Reservation ${reservation.id} classified as ${outcome}. order_id=${orderId}. ${DRY_RUN ? "Would delete" : "Deleting"}`
      );
      if (!DRY_RUN) await adminDelete(token, `/admin/reservations/${reservation.id}`);
      deleted++;
    } else {
      console.log(
        `Reservation ${reservation.id} reported as ${outcome}. order_id=${orderId} status=${order?.status} (needs human review, not touched).`
      );
      reported++;
    }
  }

  console.log(`Done. ${deleted} reservation(s) ${DRY_RUN ? "to delete" : "deleted"}, ${reported} reservation(s) reported for review.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
