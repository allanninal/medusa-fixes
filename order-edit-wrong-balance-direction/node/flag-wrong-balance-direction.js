/**
 * Find Medusa v2 orders where a captured payment plus a pending or
 * confirmed order edit reports the balance direction backwards, refund
 * owed reported as collect, or the reverse. This is not auto-fixable:
 * it is a computed field bug in Medusa core (GitHub issues #13068,
 * #13067), not corrupted data. DRY_RUN=true (default) only reports the
 * affected orders. Only when DRY_RUN=false and a human has reviewed the
 * direction does the script add an internal_note to the order edit,
 * never a capture or refund call.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const ORDER_FIELDS = "id,display_id,status,*summary,*items,*order_change";
const EDIT_CHANGE_STATUSES = new Set(["requested", "confirmed"]);

const NOTE_TEMPLATE = (direction, pendingDifference) =>
  `Suspected reversed refund-direction bug (medusajs/medusa#13068) -- ` +
  `verify manually before force-confirming or capturing/refunding payment. ` +
  `recomputed_direction=${direction} pending_difference=${pendingDifference}`;

export function hasRelevantEdit(order) {
  const change = order.order_change || {};
  return change.change_type === "edit" && EDIT_CHANGE_STATUSES.has(change.status);
}

export function decideBalanceAction(currentOrderTotal, paidTotal) {
  // Pure: no I/O. pending_difference semantics per Medusa OrderSummary:
  // current_order_total - paid_total. Negative means refund owed to the
  // customer, positive means more is owed by the customer.
  const diff = Number(currentOrderTotal) - Number(paidTotal);
  if (diff === 0) return { pendingDifference: 0, direction: "none" };
  return diff < 0
    ? { pendingDifference: diff, direction: "refund" }
    : { pendingDifference: diff, direction: "collect" };
}

export function reportedDirection(order) {
  // Read the direction the app/UI is currently using, from the order's
  // own summary.pending_difference, the exact field the bug can flip.
  const summary = order.summary || {};
  const reported = summary.pending_difference;
  if (reported == null) return null;
  if (reported === 0) return "none";
  return reported < 0 ? "refund" : "collect";
}

async function login() {
  const { default: Medusa } = await import("@medusajs/js-sdk");
  const sdk = new Medusa({ baseUrl: BASE_URL, auth: { type: "jwt" } });
  await sdk.auth.login("user", "emailpass", { email: EMAIL, password: PASSWORD });
  return sdk;
}

async function listPaidEditedOrders(sdk) {
  const out = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const body = await sdk.admin.order.list({ fields: ORDER_FIELDS, limit, offset });
    for (const o of body.orders) {
      const paidTotal = o.summary?.paid_total || 0;
      if (paidTotal > 0 && hasRelevantEdit(o)) out.push(o);
    }
    offset += limit;
    if (offset >= body.count) return out;
  }
}

async function addInternalNote(sdk, orderEditId, note) {
  return sdk.client.fetch(`/admin/order-edits/${orderEditId}`, {
    method: "POST",
    body: { internal_note: note },
  });
}

export async function run() {
  const sdk = await login();
  const orders = await listPaidEditedOrders(sdk);

  const flagged = [];
  for (const order of orders) {
    const summary = order.summary || {};
    const expected = decideBalanceAction(summary.current_order_total || 0, summary.paid_total || 0);
    const reported = reportedDirection(order);
    if (reported !== null && reported !== expected.direction) {
      flagged.push([order, expected, reported]);
    }
  }

  if (flagged.length === 0) {
    console.log(`No direction mismatches found across ${orders.length} paid, edited order(s).`);
    return;
  }

  for (const [order, expected, reported] of flagged) {
    const change = order.order_change || {};
    const orderEditId = change.id;
    const summary = order.summary || {};
    console.warn(
      `Order ${order.id} (display #${order.display_id}): reported=${reported} expected=${expected.direction} ` +
      `paid_total=${summary.paid_total} current_order_total=${summary.current_order_total} ` +
      `pending_difference=${expected.pendingDifference}. ${DRY_RUN ? "Would report only" : "Reported, adding internal note"}`
    );
    if (!DRY_RUN && orderEditId) {
      await addInternalNote(sdk, orderEditId, NOTE_TEMPLATE(expected.direction, expected.pendingDifference));
    }
  }

  console.log(`Done. ${flagged.length} order(s) flagged with a mismatched balance direction.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
