import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFulfillmentRepair } from "./flag-stuck-fulfillment.js";

function order({ fulfillmentStatus = "delivered", refundedTotal = 0.0, items, returns = [] } = {}) {
  return {
    id: "order_1",
    fulfillment_status: fulfillmentStatus,
    summary: { refunded_total: refundedTotal },
    items: items || [{ id: "item_1", quantity: 2, unit_price: 50.0 }],
    returns,
  };
}

function received({ status = "received", lines } = {}) {
  return { status, items: lines || [{ item_id: "item_1", quantity: 2 }] };
}

test("stuck delivered when fully returned and refunded", () => {
  const o = order({ refundedTotal: 100.0, returns: [received()] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, true);
  assert.equal(result.reason, "stuck_delivered");
  assert.equal(result.receivedQty, 2);
  assert.equal(result.returnedValue, 100.0);
});

test("not returned when no returns present", () => {
  const o = order({ refundedTotal: 0.0, returns: [] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, false);
  assert.equal(result.reason, "not_returned");
});

test("in progress when return partially received", () => {
  const o = order({ refundedTotal: 50.0, returns: [received({ lines: [{ item_id: "item_1", quantity: 1 }] })] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, false);
  assert.equal(result.reason, "in_progress");
});

test("in progress when received but refund not issued yet", () => {
  const o = order({ refundedTotal: 0.0, returns: [received()] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, false);
  assert.equal(result.reason, "in_progress");
});

test("ignores returns not yet received", () => {
  const o = order({ refundedTotal: 0.0, returns: [received({ status: "requested" })] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, false);
  assert.equal(result.reason, "not_returned");
});

test("not stuck when fulfillment status already updated", () => {
  const o = order({ fulfillmentStatus: "canceled", refundedTotal: 100.0, returns: [received()] });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.isStuck, false);
  assert.equal(result.reason, "not_returned");
});

test("sums across multiple returns and items", () => {
  const items = [
    { id: "item_1", quantity: 2, unit_price: 30.0 },
    { id: "item_2", quantity: 1, unit_price: 40.0 },
  ];
  const returns = [
    received({ lines: [{ item_id: "item_1", quantity: 2 }] }),
    received({ lines: [{ item_id: "item_2", quantity: 1 }] }),
  ];
  const o = order({ refundedTotal: 100.0, items, returns });
  const result = decideFulfillmentRepair(o);
  assert.equal(result.fulfilledQty, 3);
  assert.equal(result.receivedQty, 3);
  assert.equal(result.returnedValue, 100.0);
  assert.equal(result.isStuck, true);
});
