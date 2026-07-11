import { test } from "node:test";
import assert from "node:assert/strict";
import { isStuckInvoking, detectFlapping } from "./flag-stuck-invoking.js";

const NOW_MS = Date.parse("2026-07-10T00:20:00Z");

const row = (over = {}) => ({
  state: "invoking",
  workflowId: "create-order",
  createdAt: new Date("2026-07-10T00:00:00Z"),
  updatedAt: new Date("2026-07-10T00:00:00Z"),
  ...over,
});

test("stuck when invoking past default TTL", () => {
  assert.equal(isStuckInvoking(row(), NOW_MS, {}, 10 * 60000), true);
});

test("not stuck when within TTL", () => {
  assert.equal(isStuckInvoking(row(), NOW_MS, {}, 30 * 60000), false);
});

test("not stuck when state is done", () => {
  assert.equal(isStuckInvoking(row({ state: "done" }), NOW_MS, {}, 5 * 60000), false);
});

test("not stuck when state is failed", () => {
  assert.equal(isStuckInvoking(row({ state: "failed" }), NOW_MS, {}, 5 * 60000), false);
});

test("not stuck when state is compensating", () => {
  assert.equal(isStuckInvoking(row({ state: "compensating" }), NOW_MS, {}, 5 * 60000), false);
});

test("uses per workflow TTL override", () => {
  const ttlOverrides = { "create-order": 30 * 60000 };
  assert.equal(isStuckInvoking(row(), NOW_MS, ttlOverrides, 10 * 60000), false);
});

test("TTL override can also flag sooner", () => {
  const ttlOverrides = { "create-order": 5 * 60000 };
  assert.equal(isStuckInvoking(row(), NOW_MS, ttlOverrides, 60 * 60000), true);
});

test("falls back to createdAt when updatedAt missing", () => {
  const r = row({ updatedAt: null, createdAt: new Date("2026-07-10T00:00:00Z") });
  assert.equal(isStuckInvoking(r, NOW_MS, {}, 10 * 60000), true);
});

test("not stuck when no timestamps at all", () => {
  const r = row({ updatedAt: null, createdAt: null });
  assert.equal(isStuckInvoking(r, NOW_MS, {}, 1), false);
});

test("exactly at TTL boundary is not stuck", () => {
  const r = row({ updatedAt: new Date("2026-07-10T00:10:00Z") });
  assert.equal(isStuckInvoking(r, NOW_MS, {}, 10 * 60000), false);
});

test("detectFlapping finds reappeared transaction", () => {
  const everSeen = new Set(["txn_1", "txn_2"]);
  const previous = new Set(["txn_2"]); // txn_1 was missing on the last poll
  const current = new Set(["txn_1", "txn_2"]); // txn_1 is back
  assert.deepEqual(detectFlapping(previous, current, everSeen), new Set(["txn_1"]));
});

test("detectFlapping is empty when nothing reappeared", () => {
  const everSeen = new Set(["txn_1"]);
  const previous = new Set(["txn_1"]);
  const current = new Set(["txn_1"]);
  assert.deepEqual(detectFlapping(previous, current, everSeen), new Set());
});
