import { test } from "node:test";
import assert from "node:assert/strict";
import { findStaleReservations } from "./find-stale-reservations.js";

const order = (over = {}) => ({
  id: "order_1",
  status: "completed",
  fulfillment_status: "fulfilled",
  items: [{ id: "item_1" }],
  ...over,
});

const reservation = (over = {}) => ({
  id: "res_1",
  line_item_id: "item_1",
  quantity: 2,
  ...over,
});

test("flags reservation when order completed and fulfilled", () => {
  const result = findStaleReservations([order()], [reservation()]);
  assert.deepEqual(result, [
    { reservation_id: "res_1", order_id: "order_1", line_item_id: "item_1", quantity: 2 },
  ]);
});

test("flags reservation when order canceled and fulfillment canceled", () => {
  const o = order({ status: "canceled", fulfillment_status: "canceled" });
  const result = findStaleReservations([o], [reservation()]);
  assert.equal(result.length, 1);
});

test("keeps reservation when order still in progress", () => {
  const o = order({ status: "pending", fulfillment_status: "not_fulfilled" });
  const result = findStaleReservations([o], [reservation()]);
  assert.deepEqual(result, []);
});

test("keeps reservation when order completed but fulfillment not terminal", () => {
  const o = order({ status: "completed", fulfillment_status: "partially_fulfilled" });
  const result = findStaleReservations([o], [reservation()]);
  assert.deepEqual(result, []);
});

test("keeps reservation with no matching line item", () => {
  const result = findStaleReservations([order()], [reservation({ line_item_id: "item_unknown" })]);
  assert.deepEqual(result, []);
});

test("keeps reservation with no line_item_id", () => {
  const result = findStaleReservations([order()], [reservation({ line_item_id: null })]);
  assert.deepEqual(result, []);
});

test("handles multiple orders and multiple reservations", () => {
  const orders = [
    order({ id: "order_1", items: [{ id: "item_1" }] }),
    order({ id: "order_2", status: "pending", fulfillment_status: "not_fulfilled", items: [{ id: "item_2" }] }),
  ];
  const reservations = [
    reservation({ id: "res_1", line_item_id: "item_1", quantity: 2 }),
    reservation({ id: "res_2", line_item_id: "item_2", quantity: 5 }),
  ];
  const result = findStaleReservations(orders, reservations);
  assert.deepEqual(result, [
    { reservation_id: "res_1", order_id: "order_1", line_item_id: "item_1", quantity: 2 },
  ]);
});
