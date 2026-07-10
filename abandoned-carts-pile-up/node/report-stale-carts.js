/**
 * Find Medusa carts that piled up because they never converted to an order.
 *
 * A Medusa v2 cart is a first-class, persistent record in the Cart Module, created as
 * soon as a shopper's session needs one and only marked complete by setting completed_at
 * when it converts into an order. Medusa ships no default scheduled job for cart
 * retention, so nothing expires, archives, or deletes a cart that never reaches checkout.
 * This lists carts, classifies each one with a pure function, cross-checks anything
 * flagged against real orders, and writes a report of stale cart_ids for manual review.
 * This is flag and report only. It never deletes a cart on its own.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/abandoned-carts-pile-up/
 */
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const STALE_DAYS = Number(process.env.STALE_DAYS || 30);
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const REPORT_PATH = process.env.REPORT_PATH || "stale_carts_report.json";

/**
 * Pure decision function. No I/O.
 *
 * @param {{ id: string, completed_at: string | null, updated_at: string, item_count: number }} cart
 * @param {Date} now
 * @param {number} staleDays
 * @returns {{ stale: boolean, reason: string }}
 */
export function classifyStaleCart(cart, now, staleDays = 30) {
  if (cart.completed_at) return { stale: false, reason: "completed" };

  const ageMs = now.getTime() - new Date(cart.updated_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (cart.item_count === 0) return { stale: false, reason: "empty-cart-not-abandoned" };

  if (ageDays >= staleDays) return { stale: true, reason: `inactive-${Math.floor(ageDays)}d-with-items` };

  return { stale: false, reason: "recent" };
}

export function cartTotal(cart) {
  const items = cart.items || [];
  return items.reduce((sum, i) => sum + Number(i.unit_price || 0) * Number(i.quantity || 0), 0);
}

export function toReportRow(cart, ageDays) {
  const items = cart.items || [];
  return {
    cart_id: cart.id,
    email: cart.email || cart.customer_id,
    region_id: cart.region_id,
    sales_channel_id: cart.sales_channel_id,
    item_count: items.length,
    cart_total: cartTotal(cart),
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

async function listCarts(token) {
  const carts = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/carts", {
      fields: "id,email,customer_id,region_id,sales_channel_id,completed_at,created_at,updated_at,*items",
      limit,
      offset,
    });
    carts.push(...data.carts);
    offset += limit;
    if (offset >= data.count) return carts;
  }
}

async function completedCartIds(token) {
  const cartIds = new Set();
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/orders", {
      fields: "id,cart_id",
      limit,
      offset,
    });
    for (const order of data.orders) {
      if (order.cart_id) cartIds.add(order.cart_id);
    }
    offset += limit;
    if (offset >= data.count) return cartIds;
  }
}

/**
 * Not called by run(). Kept for a team that explicitly opts into automated
 * deletion, gated behind DRY_RUN, only for a cart_id confirmed to have no order.
 */
async function deleteCart(token, cartId) {
  return adminDelete(token, `/admin/carts/${cartId}`);
}

export async function run() {
  const token = await getAdminToken();
  const carts = await listCarts(token);
  const confirmedOrders = await completedCartIds(token);
  const now = new Date();

  const report = [];
  for (const cart of carts) {
    const items = cart.items || [];
    const shaped = {
      id: cart.id,
      completed_at: cart.completed_at,
      updated_at: cart.updated_at || cart.created_at,
      item_count: items.length,
    };
    const outcome = classifyStaleCart(shaped, now, STALE_DAYS);
    if (!outcome.stale) continue;
    if (confirmedOrders.has(cart.id)) {
      console.log(`Cart ${cart.id} classified stale but has a matching order, skipping.`);
      continue;
    }

    const ageDays = (now.getTime() - new Date(shaped.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    const row = toReportRow(cart, ageDays);
    report.push(row);
    console.warn(`Stale cart ${row.cart_id}: ${outcome.reason}, age=${ageDays.toFixed(1)}d, total=${row.cart_total}`);
  }

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Done. ${report.length} stale cart(s) written to ${REPORT_PATH}. ${DRY_RUN ? "(dry run, no deletes ever run from this script)" : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
