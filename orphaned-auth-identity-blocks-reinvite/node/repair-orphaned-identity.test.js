import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedAuthIdentities } from "./repair-orphaned-identity.js";

const NOW = new Date("2026-07-10T00:00:00Z");

const invite = (over = {}) => ({
  id: "invite_01",
  email: "jane@example.com",
  accepted: false,
  expires_at: "2026-07-20T00:00:00Z",
  ...over,
});

const identity = (over = {}) => ({
  id: "au_01",
  entityId: "jane@example.com",
  providerId: "emailpass",
  ...over,
});

test("no decision when no matching identity", () => {
  const result = findOrphanedAuthIdentities([invite()], [], [], NOW);
  assert.deepEqual(result, []);
});

test("delete when pending, orphaned, and not expired", () => {
  const result = findOrphanedAuthIdentities([invite()], [identity()], [], NOW);
  assert.deepEqual(result, [
    { inviteId: "invite_01", email: "jane@example.com", authIdentityId: "au_01", action: "delete_auth_identity" },
  ]);
});

test("flag ambiguous when user already exists", () => {
  const users = [{ id: "user_01", email: "jane@example.com" }];
  const result = findOrphanedAuthIdentities([invite()], [identity()], users, NOW);
  assert.deepEqual(result, [
    { inviteId: "invite_01", email: "jane@example.com", authIdentityId: "au_01", action: "flag_ambiguous" },
  ]);
});

test("resend invite when expired", () => {
  const expired = invite({ expires_at: "2026-07-01T00:00:00Z" });
  const result = findOrphanedAuthIdentities([expired], [identity()], [], NOW);
  assert.deepEqual(result, [
    { inviteId: "invite_01", email: "jane@example.com", authIdentityId: "au_01", action: "resend_invite" },
  ]);
});

test("skip when invite already accepted", () => {
  const accepted = invite({ accepted: true });
  const result = findOrphanedAuthIdentities([accepted], [identity()], [], NOW);
  assert.deepEqual(result, []);
});

test("skip when no auth identity matches the invite email", () => {
  const result = findOrphanedAuthIdentities([invite({ email: "nobody@example.com" })], [identity()], [], NOW);
  assert.deepEqual(result, []);
});

test("user check wins over expired invite", () => {
  const expired = invite({ expires_at: "2026-07-01T00:00:00Z" });
  const users = [{ id: "user_01", email: "jane@example.com" }];
  const result = findOrphanedAuthIdentities([expired], [identity()], users, NOW);
  assert.equal(result[0].action, "flag_ambiguous");
});

test("case and whitespace are normalized", () => {
  const messyInvite = invite({ email: "  Jane@Example.com  " });
  const result = findOrphanedAuthIdentities([messyInvite], [identity()], [], NOW);
  assert.equal(result[0].action, "delete_auth_identity");
});

test("multiple invites get independent decisions", () => {
  const invites = [
    invite({ id: "invite_01", email: "jane@example.com" }),
    invite({ id: "invite_02", email: "john@example.com", expires_at: "2026-07-01T00:00:00Z" }),
  ];
  const identities = [
    identity({ id: "au_01", entityId: "jane@example.com" }),
    identity({ id: "au_02", entityId: "john@example.com" }),
  ];
  const result = findOrphanedAuthIdentities(invites, identities, [], NOW);
  const actions = Object.fromEntries(result.map((d) => [d.inviteId, d.action]));
  assert.deepEqual(actions, { invite_01: "delete_auth_identity", invite_02: "resend_invite" });
});
