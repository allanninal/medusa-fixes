/**
 * Flag a Medusa v2 admin invite that will fail at accept time because the
 * target email already has a customer AuthIdentity. Both customer registration
 * and invite acceptance call the same auth provider register method, which is
 * keyed only on email with no actor_type awareness, so a customer identity on
 * that email guarantees a 401 Identity with email already exists when the
 * invite is accepted. This never mutates an existing identity. DRY_RUN=true
 * only reports the collision check. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/admin-invite-email-collision/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const TARGET_EMAIL = process.env.TARGET_EMAIL || "jane@example.com";
const INVITE_ROLE = process.env.INVITE_ROLE || "admin";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

export function willInviteCollide(targetEmail, customers, adminUsers, pendingInvites) {
  // Pure: no I/O. Returns { safe, reason }.
  // reason is one of "customer_account_exists", "admin_user_exists",
  // "invite_pending", or "ok".
  const email = targetEmail.trim().toLowerCase();

  const customerHit = customers.find(
    (c) => (c.email || "").trim().toLowerCase() === email && c.has_account === true
  );
  if (customerHit) return { safe: false, reason: "customer_account_exists" };

  const adminHit = adminUsers.find((u) => (u.email || "").trim().toLowerCase() === email);
  if (adminHit) return { safe: false, reason: "admin_user_exists" };

  const inviteHit = pendingInvites.find(
    (i) => (i.email || "").trim().toLowerCase() === email && i.accepted !== true
  );
  if (inviteHit) return { safe: false, reason: "invite_pending" };

  return { safe: true, reason: "ok" };
}

async function getToken() {
  const res = await fetch(`${BASE_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Medusa auth ${res.status}`);
  const body = await res.json();
  return body.token;
}

async function apiGet(token, path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Medusa ${path} ${res.status}`);
  return res.json();
}

async function findCustomers(token, email) {
  const body = await apiGet(token, "/admin/customers", { email, fields: "id,email,has_account" });
  return body.customers;
}

async function findAdminUsers(token, email) {
  const body = await apiGet(token, "/admin/users", { email, fields: "id,email" });
  return body.users;
}

async function listPendingInvites(token) {
  const body = await apiGet(token, "/admin/invites", { fields: "id,email,accepted,expires_at" });
  return body.invites;
}

async function createInvite(token, email, role) {
  const res = await fetch(`${BASE_URL}/admin/invites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) throw new Error(`Medusa ${res.status}`);
  const body = await res.json();
  return body.invite;
}

export async function run() {
  const token = await getToken();
  const [customers, adminUsers, pendingInvites] = await Promise.all([
    findCustomers(token, TARGET_EMAIL),
    findAdminUsers(token, TARGET_EMAIL),
    listPendingInvites(token),
  ]);

  const decision = willInviteCollide(TARGET_EMAIL, customers, adminUsers, pendingInvites);

  if (!decision.safe) {
    console.warn(
      `Blocked: invite to ${TARGET_EMAIL} would collide (${decision.reason}). Invite a different email instead.`
    );
    return;
  }

  console.log(`Email ${TARGET_EMAIL} is clear. ${DRY_RUN ? "would create invite" : "creating invite"}`);
  if (!DRY_RUN) {
    const invite = await createInvite(token, TARGET_EMAIL, INVITE_ROLE);
    console.log(`Invite created: ${invite.id}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
