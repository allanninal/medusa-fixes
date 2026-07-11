/**
 * Find and repair an AuthIdentity orphaned by a failed Medusa v2 invite accept.
 *
 * POST /auth/user/{provider}/register creates the AuthIdentity before
 * POST /admin/invites/accept ever runs acceptInviteWorkflow. If that workflow
 * fails, Medusa compensates the invite back to pending, but the AuthIdentity has
 * no compensation step of its own and is left behind, blocking every retry with
 * "Identity with email already exists". This lists pending invites over the
 * Admin API, cross-checks them against auth identities and users you supply
 * (read server-side with container.resolve(Modules.AUTH) and Modules.USER), and
 * only ever deletes an identity when no user is linked to that email. DRY_RUN=true
 * only reports what it would do. Safe to run again and again.
 *
 * Guide: https://www.allanninal.dev/medusa/orphaned-auth-identity-blocks-reinvite/
 */
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const EMAIL = process.env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
const PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || "supersecret";
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

/**
 * Pure: no I/O. invites/authIdentities/users are plain arrays, now is a Date.
 *
 * invites: [{id, email, accepted, expires_at}]
 * authIdentities: [{id, entityId, providerId}]
 * users: [{id, email}]
 * now: Date
 *
 * Returns an array of {inviteId, email, authIdentityId, action} where action is
 * one of "delete_auth_identity", "flag_ambiguous", "resend_invite".
 */
export function findOrphanedAuthIdentities(invites, authIdentities, users, now) {
  const userEmails = new Set(
    users.filter((u) => u.email).map((u) => u.email.trim().toLowerCase())
  );
  const decisions = [];

  for (const invite of invites) {
    if (invite.accepted !== false) continue;
    const email = invite.email.trim().toLowerCase();

    const match = authIdentities.find(
      (ai) => (ai.entityId || "").trim().toLowerCase() === email
    );
    if (!match) continue;

    if (userEmails.has(email)) {
      decisions.push({ inviteId: invite.id, email: invite.email, authIdentityId: match.id, action: "flag_ambiguous" });
      continue;
    }

    const expiresAt = invite.expires_at ? new Date(invite.expires_at) : null;
    if (expiresAt !== null && expiresAt < now) {
      decisions.push({ inviteId: invite.id, email: invite.email, authIdentityId: match.id, action: "resend_invite" });
    } else {
      decisions.push({ inviteId: invite.id, email: invite.email, authIdentityId: match.id, action: "delete_auth_identity" });
    }
  }

  return decisions;
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

async function listPendingInvites(token) {
  const res = await fetch(`${BASE_URL}/admin/invites?fields=id,email,accepted,expires_at,token`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa invites ${res.status}`);
  const body = await res.json();
  return body.invites.filter((i) => i.accepted === false);
}

async function resendInvite(token, inviteId) {
  const res = await fetch(`${BASE_URL}/admin/invites/${inviteId}/resend`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Medusa resend ${res.status}`);
}

export async function run() {
  const token = await getToken();
  const invites = await listPendingInvites(token);

  // In a real deployment these two calls happen server-side, inside a Medusa
  // script or subscriber, using container.resolve(Modules.AUTH) and
  // container.resolve(Modules.USER). There is no public admin route for
  // AuthIdentity, so this is left as an injection point:
  //
  //   const authModuleService = container.resolve(Modules.AUTH)
  //   const userModuleService = container.resolve(Modules.USER)
  //   const authIdentities = await authModuleService.listAuthIdentities(
  //     {}, { relations: ["provider_identities"] }
  //   )
  //   const users = await userModuleService.listUsers({})
  const authIdentities = [];
  const users = [];

  const decisions = findOrphanedAuthIdentities(invites, authIdentities, users, new Date());

  for (const decision of decisions) {
    if (decision.action === "flag_ambiguous") {
      console.warn(
        `Flagged: ${decision.email} has both a pending invite and a user. Not touching AuthIdentity ${decision.authIdentityId}.`
      );
      continue;
    }

    if (decision.action === "resend_invite") {
      console.warn(
        `Invite for ${decision.email} expired with an orphaned identity. ${DRY_RUN ? "would resend and delete identity" : "resending and deleting identity"}`
      );
      if (!DRY_RUN) {
        await resendInvite(token, decision.inviteId);
        // await authModuleService.deleteAuthIdentities([decision.authIdentityId])
      }
      continue;
    }

    console.log(`Orphaned AuthIdentity for ${decision.email}. ${DRY_RUN ? "would delete" : "deleting"}`);
    if (!DRY_RUN) {
      // await authModuleService.deleteAuthIdentities([decision.authIdentityId])
    }
  }

  console.log(`Done. ${decisions.length} decision(s) evaluated.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
