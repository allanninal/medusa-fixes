import { test } from "node:test";
import assert from "node:assert/strict";
import { willInviteCollide } from "./check-invite-collision.js";

test("ok when no matches anywhere", () => {
  const result = willInviteCollide("new@example.com", [], [], []);
  assert.deepEqual(result, { safe: true, reason: "ok" });
});

test("blocked when customer has account", () => {
  const customers = [{ email: "jane@example.com", has_account: true }];
  const result = willInviteCollide("jane@example.com", customers, [], []);
  assert.deepEqual(result, { safe: false, reason: "customer_account_exists" });
});

test("not blocked when customer has no account", () => {
  const customers = [{ email: "jane@example.com", has_account: false }];
  const result = willInviteCollide("jane@example.com", customers, [], []);
  assert.deepEqual(result, { safe: true, reason: "ok" });
});

test("blocked when admin user already exists", () => {
  const adminUsers = [{ email: "jane@example.com" }];
  const result = willInviteCollide("jane@example.com", [], adminUsers, []);
  assert.deepEqual(result, { safe: false, reason: "admin_user_exists" });
});

test("blocked when invite already pending", () => {
  const invites = [{ email: "jane@example.com", accepted: false }];
  const result = willInviteCollide("jane@example.com", [], [], invites);
  assert.deepEqual(result, { safe: false, reason: "invite_pending" });
});

test("not blocked when invite already accepted", () => {
  const invites = [{ email: "jane@example.com", accepted: true }];
  const result = willInviteCollide("jane@example.com", [], [], invites);
  assert.deepEqual(result, { safe: true, reason: "ok" });
});

test("normalizes case and whitespace", () => {
  const customers = [{ email: "Jane@Example.com", has_account: true }];
  const result = willInviteCollide("  jane@example.com  ", customers, [], []);
  assert.deepEqual(result, { safe: false, reason: "customer_account_exists" });
});

test("customer check wins over other reasons", () => {
  const customers = [{ email: "jane@example.com", has_account: true }];
  const adminUsers = [{ email: "jane@example.com" }];
  const result = willInviteCollide("jane@example.com", customers, adminUsers, []);
  assert.equal(result.reason, "customer_account_exists");
});

test("no match when email differs", () => {
  const customers = [{ email: "someone-else@example.com", has_account: true }];
  const result = willInviteCollide("jane@example.com", customers, [], []);
  assert.deepEqual(result, { safe: true, reason: "ok" });
});

test("missing email field does not crash", () => {
  const customers = [{ has_account: true }];
  const result = willInviteCollide("jane@example.com", customers, [], []);
  assert.deepEqual(result, { safe: true, reason: "ok" });
});
