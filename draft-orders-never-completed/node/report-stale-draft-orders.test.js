import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleDraft } from "./report-stale-draft-orders.js";

// Fixed clock: 2026-07-10 00:00:00 UTC, as epoch seconds.
const NOW = new Date("2026-07-10T00:00:00Z").getTime() / 1000;

const order = (over = {}) => ({
  id: "order_1",
  status: "draft",
  is_draft_order: true,
  created_at: "2026-06-01T00:00:00Z",
  ...over,
});

test("stale when old draft", () => {
  const result = isStaleDraft(order(), NOW, 30);
  assert.equal(result.stale, true);
  assert.ok(result.reason.startsWith("draft-"));
});

test("not stale when not a draft", () => {
  const result = isStaleDraft(order({ status: "completed", is_draft_order: false }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "not-a-draft" });
});

test("not stale when recent draft", () => {
  const result = isStaleDraft(order({ created_at: "2026-07-09T00:00:00Z" }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "recent-draft" });
});

test("exactly at threshold is stale", () => {
  const result = isStaleDraft(order({ created_at: "2026-06-10T00:00:00Z" }), NOW, 30);
  assert.equal(result.stale, true);
});

test("draft recognized by status alone", () => {
  const result = isStaleDraft(order({ is_draft_order: undefined }), NOW, 30);
  assert.equal(result.stale, true);
});

test("no created_at is not stale", () => {
  const result = isStaleDraft(order({ created_at: null }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "no-created-at" });
});

test("not a draft wins even when old", () => {
  const result = isStaleDraft(order({ status: "pending", is_draft_order: false, created_at: "2026-01-01T00:00:00Z" }), NOW, 30);
  assert.deepEqual(result, { stale: false, reason: "not-a-draft" });
});
