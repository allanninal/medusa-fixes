import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReservation } from "./clear-blocking-reservations.js";

const LEVELS = [{ location_id: "sloc_1", stocked_quantity: 1, reserved_quantity: 1 }];

const reservation = (over = {}) => ({
  id: "res_1",
  line_item_id: "item_1",
  quantity: 1,
  location_id: "sloc_1",
  ...over,
});

test("manual_keep when no line_item_id", () => {
  const r = reservation({ line_item_id: null });
  assert.equal(classifyReservation(r, null, LEVELS), "manual_keep");
});

test("orphan_missing_order when order info is null", () => {
  const r = reservation();
  assert.equal(classifyReservation(r, null, LEVELS), "orphan_missing_order");
});

test("orphan_missing_order when order does not exist", () => {
  const r = reservation();
  assert.equal(classifyReservation(r, { exists: false }, LEVELS), "orphan_missing_order");
});

test("orphan_canceled_order", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "canceled", fulfillment_status: "not_fulfilled" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "orphan_canceled_order");
});

test("orphan_archived_order", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "archived", fulfillment_status: "not_fulfilled" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "orphan_canceled_order");
});

test("orphan_already_fulfilled", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "completed", fulfillment_status: "fulfilled" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "orphan_already_fulfilled");
});

test("orphan_already_shipped", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "completed", fulfillment_status: "shipped" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "orphan_already_fulfilled");
});

test("orphan_already_delivered", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "completed", fulfillment_status: "delivered" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "orphan_already_fulfilled");
});

test("keep when order is open and unfulfilled", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "pending", fulfillment_status: "not_fulfilled" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "keep");
});

test("keep when order is completed but not yet fulfilled", () => {
  const r = reservation();
  const orderInfo = { exists: true, status: "completed", fulfillment_status: "not_fulfilled" };
  assert.equal(classifyReservation(r, orderInfo, LEVELS), "keep");
});
