import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReservationAction } from "./retry-backorder-reservation.js";

const item = (over = {}) => ({
  variantId: "variant_1",
  inventoryItemId: "iitem_1",
  locationId: "sloc_1",
  allowBackorder: true,
  manageInventory: true,
  stockedQuantity: 0,
  reservedQuantity: 0,
  requestedQuantity: 1,
  ...over,
});

test("noop when inventory not managed", () => {
  const result = decideReservationAction(item({ manageInventory: false }), true);
  assert.equal(result.action, "noop");
});

test("noop when stock sufficient", () => {
  const result = decideReservationAction(item({ stockedQuantity: 5 }), false);
  assert.equal(result.action, "noop");
});

test("noop when stock exactly meets requested", () => {
  const result = decideReservationAction(item({ stockedQuantity: 1, requestedQuantity: 1 }), false);
  assert.equal(result.action, "noop");
});

test("flag legitimate stockout when backorder disabled", () => {
  const result = decideReservationAction(item({ allowBackorder: false }), false);
  assert.equal(result.action, "flag_legitimate_stockout");
});

test("flag legitimate stockout when backorder disabled even in dry run", () => {
  const result = decideReservationAction(item({ allowBackorder: false }), true);
  assert.equal(result.action, "flag_legitimate_stockout");
});

test("flag when backorder enabled but dry run", () => {
  const result = decideReservationAction(item(), true);
  assert.equal(result.action, "flag_legitimate_stockout");
});

test("retry when backorder enabled, negative stock, not dry run", () => {
  const result = decideReservationAction(item({ stockedQuantity: -3 }), false);
  assert.equal(result.action, "retry_complete");
});

test("retry when backorder enabled, zero stock, not dry run", () => {
  const result = decideReservationAction(item({ stockedQuantity: 0 }), false);
  assert.equal(result.action, "retry_complete");
});

test("retry when backorder enabled, positive but insufficient stock", () => {
  const result = decideReservationAction(item({ stockedQuantity: 1, requestedQuantity: 5 }), false);
  assert.equal(result.action, "retry_complete");
});

test("noop when manageInventory is falsy (null)", () => {
  const result = decideReservationAction(item({ manageInventory: null }), false);
  assert.equal(result.action, "noop");
});
