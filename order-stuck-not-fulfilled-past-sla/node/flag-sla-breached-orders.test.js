import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateOrderSla } from "./flag-sla-breached-orders.js";

const NOW_MS = Date.parse("2026-07-10T00:00:00Z");

const order = (over = {}) => ({
  status: "completed",
  payment_status: "captured",
  fulfillment_status: "not_fulfilled",
  fulfillments: [],
  created_at: "2026-07-06T00:00:00Z", // 96h before NOW_MS
  metadata: {},
  ...over,
});

test("breached when paid, unfulfilled, and past SLA", () => {
  const result = evaluateOrderSla(order(), NOW_MS, 48);
  assert.equal(result.breached, true);
  assert.equal(result.alreadyFlagged, false);
  assert.equal(Math.round(result.ageHours), 96);
});

test("not breached when within SLA", () => {
  const result = evaluateOrderSla(order({ created_at: "2026-07-09T12:00:00Z" }), NOW_MS, 48);
  assert.equal(result.breached, false);
});

test("not breached when not paid", () => {
  const result = evaluateOrderSla(order({ payment_status: "not_paid" }), NOW_MS, 48);
  assert.equal(result.breached, false);
});

test("breached when paid via payment_collections", () => {
  const result = evaluateOrderSla(
    order({ payment_status: null, payment_collections: [{ status: "captured" }] }),
    NOW_MS,
    48
  );
  assert.equal(result.breached, true);
});

test("not breached when a payment collection is not captured", () => {
  const result = evaluateOrderSla(
    order({ payment_status: null, payment_collections: [{ status: "captured" }, { status: "not_paid" }] }),
    NOW_MS,
    48
  );
  assert.equal(result.breached, false);
});

test("not breached when already fulfilled", () => {
  const result = evaluateOrderSla(
    order({ fulfillment_status: "fulfilled", fulfillments: [{ id: "ful_1" }] }),
    NOW_MS,
    48
  );
  assert.equal(result.breached, false);
});

test("breached when partially fulfilled past SLA", () => {
  const result = evaluateOrderSla(
    order({ fulfillment_status: "partially_fulfilled", fulfillments: [{ id: "ful_1" }] }),
    NOW_MS,
    48
  );
  assert.equal(result.breached, true);
});

test("breached when not_fulfilled status even if fulfillments array is non-empty", () => {
  const result = evaluateOrderSla(
    order({ fulfillment_status: "not_fulfilled", fulfillments: [{ id: "ful_stale" }] }),
    NOW_MS,
    48
  );
  assert.equal(result.breached, true);
});

test("not breached when canceled", () => {
  const result = evaluateOrderSla(order({ status: "canceled" }), NOW_MS, 48);
  assert.equal(result.breached, false);
});

test("not breached when already flagged", () => {
  const result = evaluateOrderSla(order({ metadata: { sla_flagged: true } }), NOW_MS, 48);
  assert.equal(result.breached, false);
  assert.equal(result.alreadyFlagged, true);
});

test("exactly at SLA boundary is not breached", () => {
  const result = evaluateOrderSla(order({ created_at: "2026-07-08T00:00:00Z" }), NOW_MS, 48);
  assert.equal(result.breached, false);
});

test("missing created_at is not breached", () => {
  const result = evaluateOrderSla(order({ created_at: null }), NOW_MS, 48);
  assert.equal(result.breached, false);
});
