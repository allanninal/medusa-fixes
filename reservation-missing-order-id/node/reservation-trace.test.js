import { test } from "node:test";
import assert from "node:assert/strict";
import { traceReservationsToOrders } from "./trace-reservation-orders.js";

const reservation = (over = {}) => ({
  id: "res_1",
  line_item_id: "item_1",
  inventory_item_id: "iitem_1",
  quantity: 2,
  ...over,
});

const order = (over = {}) => ({ id: "order_1", items: [{ id: "item_1" }], ...over });

test("traced when line_item matches an order", () => {
  const result = traceReservationsToOrders([reservation()], [order()]);
  assert.deepEqual(result, [{ reservation_id: "res_1", order_id: "order_1", status: "traced" }]);
});

test("no_line_item when reservation has none", () => {
  const r = reservation({ line_item_id: null });
  const result = traceReservationsToOrders([r], [order()]);
  assert.deepEqual(result, [{ reservation_id: "res_1", order_id: null, status: "no_line_item" }]);
});

test("orphaned_line_item when no order matches", () => {
  const r = reservation({ line_item_id: "item_missing" });
  const result = traceReservationsToOrders([r], [order()]);
  assert.deepEqual(result, [{ reservation_id: "res_1", order_id: null, status: "orphaned_line_item" }]);
});

test("orphaned_line_item when there are no orders at all", () => {
  const result = traceReservationsToOrders([reservation()], []);
  assert.equal(result[0].status, "orphaned_line_item");
});

test("multiple reservations resolve independently", () => {
  const reservations = [
    reservation({ id: "res_1", line_item_id: "item_1" }),
    reservation({ id: "res_2", line_item_id: null }),
    reservation({ id: "res_3", line_item_id: "item_gone" }),
  ];
  const result = traceReservationsToOrders(reservations, [order()]);
  const statuses = Object.fromEntries(result.map((r) => [r.reservation_id, r.status]));
  assert.deepEqual(statuses, { res_1: "traced", res_2: "no_line_item", res_3: "orphaned_line_item" });
});

test("empty line_item_id string treated as no_line_item", () => {
  const r = reservation({ line_item_id: "" });
  const result = traceReservationsToOrders([r], [order()]);
  assert.deepEqual(result, [{ reservation_id: "res_1", order_id: null, status: "no_line_item" }]);
});
