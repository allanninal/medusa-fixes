/**
 * Find Medusa orders still linked to an orphaned guest customer record.
 *
 * Medusa v2 keys a Customer row by (email, has_account), not by email alone. A
 * guest checkout creates a Customer with has_account false, and the order's
 * customer_id points at that row. When the same person later registers with
 * the same email, Medusa creates a separate Customer row with has_account
 * true. It does not retroactively update the existing order's customer_id, so
 * the order stays linked to the old guest record, invisible to the new
 * authenticated account.
 *
 * Medusa deliberately does not auto-merge these on registration, since
 * blindly re-linking by email would let anyone claim another person's guest
 * orders just by signing up with that email. Instead Medusa ships a
 * consent-based Order Transfer workflow: an admin-initiated request that
 * notifies the original guest order owner by email, and only completes once
 * they accept it.
 *
 * This script only reads by default. It pages through every customer, flags
 * the orphaned guest-plus-registered pattern, lists the stuck orders per
 * pair, and prints the planned transfer requests as order_id -> target
 * customer_id. Nothing is sent to Medusa unless DRY_RUN is false and a human
 * has approved the batch.
 * Run on a schedule for detection. Only run with DRY_RUN=false after review.
 *
 * Guide: https://www.allanninal.dev/medusa/orders-stuck-on-guest-customer/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CUSTOMER_FIELDS = "id,email,has_account,created_at";
const ORDER_FIELDS = "id,display_id,email,customer_id,created_at";

/**
 * Pure decision function. No I/O.
 *
 * @param {Array<{id: string, email: string, has_account: boolean}>} customers
 * @param {Array<{id: string, customer_id: string, email: string}>} orders
 * @returns {Array<{guestCustomerId: string, registeredCustomerId: string, orderIds: string[]}>}
 */
export function findOrphanedGuestOrders(customers, orders) {
  const groups = new Map();
  for (const customer of customers) {
    const email = (customer.email || "").trim().toLowerCase();
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(customer);
  }

  const results = [];
  for (const rows of groups.values()) {
    const guestRows = rows.filter((c) => c.has_account === false);
    const registeredRows = rows.filter((c) => c.has_account === true);
    if (guestRows.length !== 1 || registeredRows.length !== 1) continue;
    const guestId = guestRows[0].id;
    const orderIds = orders.filter((o) => o.customer_id === guestId).map((o) => o.id);
    results.push({
      guestCustomerId: guestId,
      registeredCustomerId: registeredRows[0].id,
      orderIds,
    });
  }
  return results;
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

async function listAllCustomers(token) {
  const customers = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const data = await adminGet(token, "/admin/customers", {
      fields: CUSTOMER_FIELDS,
      limit,
      offset,
    });
    customers.push(...data.customers);
    offset += limit;
    if (offset >= data.count) return customers;
  }
}

async function ordersForCustomer(token, customerId) {
  const data = await adminGet(token, "/admin/orders", {
    customer_id: customerId,
    fields: ORDER_FIELDS,
    limit: 100,
  });
  return data.orders;
}

async function requestOrderTransfer(token, orderId, registeredCustomerId) {
  const res = await fetch(`${BACKEND_URL}/admin/orders/${orderId}/transfer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: registeredCustomerId }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status} on POST /admin/orders/${orderId}/transfer`);
  return res.json();
}

export async function run() {
  const token = await getAdminToken();
  const customers = await listAllCustomers(token);

  const allOrders = [];
  for (const customer of customers) {
    if (customer.has_account === false) {
      allOrders.push(...(await ordersForCustomer(token, customer.id)));
    }
  }

  const pairs = findOrphanedGuestOrders(customers, allOrders);

  let planned = 0;
  for (const pair of pairs) {
    if (!pair.orderIds.length) continue;
    for (const orderId of pair.orderIds) {
      planned++;
      console.warn(
        `Planned transfer: order ${orderId} -> customer ${pair.registeredCustomerId}. ${DRY_RUN ? "dry run, not sent" : "requesting transfer"}`
      );
      if (!DRY_RUN) await requestOrderTransfer(token, orderId, pair.registeredCustomerId);
    }
  }

  console.log(`Done. ${planned} planned transfer(s) across ${pairs.length} orphaned pair(s).`);
  return pairs;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
