import { test } from "node:test";
import assert from "node:assert/strict";
import { findUntrackedShipments } from "./flag-untracked-shipments.js";

const fulfillment = (over = {}) => ({
  id: "ful_1",
  shipped_at: "2026-07-08T00:00:00Z",
  canceled_at: null,
  labels: [],
  ...over,
});

test("flagged when shipped and no labels", () => {
  const result = findUntrackedShipments([fulfillment()]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "ful_1");
  assert.equal(result[0].reason, "shipped_at set but no non-empty tracking_number on any label");
});

test("flagged when labels have blank tracking_number", () => {
  const f = fulfillment({ labels: [{ tracking_number: "" }, { tracking_number: null }] });
  assert.equal(findUntrackedShipments([f]).length, 1);
});

test("not flagged when a label has a tracking_number", () => {
  const f = fulfillment({ labels: [{ tracking_number: "1Z999AA10123456784" }] });
  assert.deepEqual(findUntrackedShipments([f]), []);
});

test("not flagged when not shipped", () => {
  const f = fulfillment({ shipped_at: null });
  assert.deepEqual(findUntrackedShipments([f]), []);
});

test("not flagged when canceled", () => {
  const f = fulfillment({ canceled_at: "2026-07-09T00:00:00Z" });
  assert.deepEqual(findUntrackedShipments([f]), []);
});

test("not flagged when tracking_number is whitespace only", () => {
  const f = fulfillment({ labels: [{ tracking_number: "   " }] });
  assert.equal(findUntrackedShipments([f]).length, 1);
});

test("not flagged when missing labels key entirely", () => {
  const f = fulfillment();
  delete f.labels;
  assert.equal(findUntrackedShipments([f]).length, 1);
});

test("multiple fulfillments only flags the untracked one", () => {
  const tracked = fulfillment({ id: "ful_2", labels: [{ tracking_number: "TRACK123" }] });
  const untracked = fulfillment({ id: "ful_3" });
  const result = findUntrackedShipments([tracked, untracked]);
  assert.deepEqual(result.map((r) => r.id), ["ful_3"]);
});

test("empty input returns empty list", () => {
  assert.deepEqual(findUntrackedShipments([]), []);
});
