/**
 * Find Medusa draft orders that were created but never completed.
 *
 * In Medusa v2 a draft order is an order with is_draft_order true and status "draft".
 * Completing it converts it into a real order. Nothing in the framework closes out a
 * draft order that a team started and then abandoned, so half-built quotes, test drafts,
 * and orders someone meant to finish later just sit in the store forever. This lists
 * draft orders, classifies each one with a pure function, and writes a report of the
 * stale ones (older than a threshold, still in draft) for manual review.
 * This is flag and report only. It never deletes a draft order on its own.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/draft-orders-never-completed/
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "stale_draft_orders_report.json";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, status: string, is_draft_order: boolean, created_at: string }} order
 * @param {number} nowEpoch current time in epoch seconds
 * @param {number} maxAgeDays
 * @returns {{ stale: boolean, reason: string }}
 */
export function isStaleDraft(order, nowEpoch, maxAgeDays = 30) {
  const isDraft = order.is_draft_order === true || order.status === "draft";
  if (!isDraft) return { stale: false, reason: "not-a-draft" };

  if (!order.created_at) return { stale: false, reason: "no-created-at" };

  const createdEpoch = new Date(order.created_at).getTime() / 1000;
  const ageDays = (nowEpoch - createdEpoch) / 86400;

  if (ageDays >= maxAgeDays) return { stale: true, reason: `draft-${Math.floor(ageDays)}d-never-completed` };

  return { stale: false, reason: "recent-draft" };
}

export function orderTotal(order) {
  if (order.total === undefined || order.total === null) return 0;
  return Number(order.total);
}

export function toReportRow(order, ageDays) {
  return {
    draft_order_id: order.id,
    display_id: order.display_id,
    email: order.email || order.customer_id,
    region_id: order.region_id,
    sales_channel_id: order.sales_channel_id,
    currency_code: order.currency_code,
    total: orderTotal(order),
    age_in_days: Math.round(ageDays * 10) / 10,
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

async function adminDelete(token, path) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on DELETE ${path}`);
  return res.json();
}

async function listDraftOrders(token) {
  const orders = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/draft-orders", {
      fields: "id,display_id,status,is_draft_order,email,customer_id,region_id,sales_channel_id,currency_code,total,created_at,updated_at",
      limit,
      offset,
    });
    orders.push(...data.draft_orders);
    offset += limit;
    if (offset >= data.count) return orders;
  }
}

/**
 * Not called by run(). Kept for a team that explicitly opts into automated
 * cleanup, gated behind DRY_RUN, only for a draft confirmed stale and reviewed.
 */
async function deleteDraftOrder(token, draftOrderId) {
  return adminDelete(token, `/admin/draft-orders/${draftOrderId}`);
}

export async function run() {
  const token = await getAdminToken();
  const drafts = await listDraftOrders(token);
  const nowEpoch = Date.now() / 1000;

  const report = [];
  for (const order of drafts) {
    const shaped = {
      id: order.id,
      status: order.status,
      is_draft_order: order.is_draft_order,
      created_at: order.created_at,
    };
    const outcome = isStaleDraft(shaped, nowEpoch, MAX_AGE_DAYS);
    if (!outcome.stale) continue;

    const ageDays = (nowEpoch - new Date(shaped.created_at).getTime() / 1000) / 86400;
    const row = toReportRow(order, ageDays);
    report.push(row);
    console.warn(`Stale draft ${row.draft_order_id}: ${outcome.reason}, age=${ageDays.toFixed(1)}d, total=${row.total}`);
  }

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Done. ${report.length} stale draft order(s) written to ${REPORT_PATH}. ${DRY_RUN ? "(dry run, no deletes ever run from this script)" : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
