/**
 * Detect Medusa customers duplicated by a guest checkout followed by registration.
 *
 * Medusa v2 stores guest and registered customers as separate Customer rows keyed
 * by email, without deduplicating across account states. A guest checkout creates
 * a row with has_account false. When that email later registers,
 * createCustomerAccountWorkflow's validateCustomerAccountCreation step only
 * rejects the registration if a row already has has_account true, so it does not
 * look up and reuse the guest row. It creates a brand new Customer row instead,
 * leaving the guest's prior orders foreign-keyed to the now-orphaned guest cus_
 * id, invisible to the newly registered account.
 *
 * This is read-only. It pages through every customer, groups them by normalized
 * email, flags the exact guest-plus-registered pattern, and for each flagged pair
 * counts the orders still stuck on the orphaned guest id. Nothing is merged or
 * written. DRY_RUN stays on by default; a confirmed merge is a separate, manual
 * step, since Medusa v2 has no documented admin route for reassigning an order's
 * customer.
 * Run on a schedule. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/guest-registration-duplicate-customer/
 */
import { pathToFileURL } from "node:url";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

const CUSTOMER_FIELDS = "id,email,has_account,created_at";

/**
 * Pure decision function. No I/O.
 *
 * Groups customer rows by normalized email, then decides per-group whether
 * this is the "guest row never merged into registered row" duplicate pattern:
 * exactly one has_account=false row AND at least one has_account=true row
 * sharing the same normalized email. Pure: no I/O, no Date.now(), fully
 * deterministic given the input array, testable with plain fixtures (single
 * guest only -> not duplicate; guest+registered -> duplicate; two registered
 * rows somehow sharing email -> flagged differently/not this pattern).
 *
 * @param {Array<{id: string, email: string, has_account: boolean}>} customers
 * @returns {Array<{email: string, guestId: string | null, registeredId: string | null, isDuplicate: boolean}>}
 */
export function findDuplicateCustomerGroups(customers) {
  const groups = new Map();
  for (const customer of customers) {
    const email = (customer.email || "").trim().toLowerCase();
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(customer);
  }

  const results = [];
  for (const [email, rows] of groups) {
    const guestRows = rows.filter((c) => c.has_account === false);
    const registeredRows = rows.filter((c) => c.has_account === true);
    const isDuplicate = guestRows.length === 1 && registeredRows.length >= 1;
    results.push({
      email,
      guestId: guestRows[0]?.id ?? null,
      registeredId: registeredRows[0]?.id ?? null,
      isDuplicate,
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

async function orphanedOrderCount(token, guestCustomerId) {
  const data = await adminGet(token, "/admin/orders", {
    customer_id: guestCustomerId,
    fields: "id,customer_id,email,display_id",
    limit: 1,
  });
  return data.count;
}

export async function run() {
  const token = await getAdminToken();
  const customers = await listAllCustomers(token);
  const groups = findDuplicateCustomerGroups(customers);
  const duplicates = groups.filter((g) => g.isDuplicate);

  const report = [];
  for (const group of duplicates) {
    const count = await orphanedOrderCount(token, group.guestId);
    const row = {
      email: group.email,
      guest_customer_id: group.guestId,
      registered_customer_id: group.registeredId,
      orphaned_order_count: count,
    };
    report.push(row);
    console.warn(
      `Duplicate pair: ${row.email} guest=${row.guest_customer_id} registered=${row.registered_customer_id} orphaned_orders=${row.orphaned_order_count}. ${DRY_RUN ? "reported only, DRY_RUN on" : "reported, no write performed"}`
    );
  }

  console.log(`Done. ${report.length} duplicate pair(s) found across ${customers.length} customer row(s).`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
