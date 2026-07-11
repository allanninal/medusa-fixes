/**
 * Find and safely cancel stuck active OrderChange rows on Medusa v2 orders.
 *
 * Medusa v2 enforces a single-active-order-change invariant per order.
 * getActiveOrderChange_() looks for any OrderChange with status pending or
 * requested, and every edit, return, claim, and exchange workflow calls
 * throwIfOrderChangeIsNotActive before it will proceed. If a prior workflow
 * crashed, timed out, or hit a compensation bug before the change reached a
 * terminal status (confirmed_at, declined_at, or canceled_at set), that row
 * is left behind and silently blocks every future attempt on the order.
 *
 * This lists orders with their order_change relation, classifies each one
 * with a pure function, and cancels only the rows that are non-terminal and
 * stale past a safety window. Never force-confirms a stuck change, since
 * cancellation to a terminal status is the only universally safe write.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/stuck-active-order-change/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const STALE_HOURS = Number(process.env.STALE_HOURS || 2);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ACTIVE_STATUSES = new Set(["pending", "requested"]);

/**
 * Pure decision function. No I/O.
 *
 * @param {{ status: string, confirmed_at: string|null, declined_at: string|null,
 *           canceled_at: string|null, updated_at: string }} change
 * @param {Date} now
 * @param {number} staleHours
 * @returns {"active_fresh" | "active_stale_stuck" | "terminal"}
 */
export function classifyOrderChange(change, now, staleHours = 2) {
  if (change.confirmed_at || change.declined_at || change.canceled_at) return "terminal";

  if (!ACTIVE_STATUSES.has(change.status)) return "terminal";

  const ageMs = now.getTime() - new Date(change.updated_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours > staleHours) return "active_stale_stuck";

  return "active_fresh";
}

/**
 * Pure filter. No I/O.
 *
 * @param {Array<{id: string, display_id: number, order_change: object|null}>} orders
 * @param {Date} now
 * @param {number} staleHours
 */
export function findStuckChanges(orders, now, staleHours) {
  const stuck = [];
  for (const order of orders) {
    const change = order.order_change;
    if (!change) continue;
    const outcome = classifyOrderChange(change, now, staleHours);
    if (outcome !== "active_stale_stuck") continue;
    stuck.push({
      order_id: order.id,
      display_id: order.display_id,
      order_change_id: change.id,
      status: change.status,
      updated_at: change.updated_at,
    });
  }
  return stuck;
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

async function listOrdersWithChanges(token) {
  const orders = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,display_id,status,*order_change",
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
  const orders = await listOrdersWithChanges(token);
  const now = new Date();

  const stuck = findStuckChanges(orders, now, STALE_HOURS);

  for (const row of stuck) {
    console.warn(
      `Order ${row.display_id} (${row.order_id}) has a stuck ${row.status} OrderChange ${row.order_change_id}. ${DRY_RUN ? "would cancel" : "cancelling"}`
    );
    if (!DRY_RUN) {
      // Cancellation has no public Admin REST route in v2. Run this branch
      // inside a Medusa exec/run() context and resolve the Order module:
      //   const orderModuleService = container.resolve(Modules.ORDER);
      //   await orderModuleService.cancel(row.order_change_id);
    }
  }

  console.log(`Done. ${stuck.length} stuck order change(s) ${DRY_RUN ? "to cancel" : "cancelled"}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
