import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrphanedGuestOrders } from "./reconcile-guest-orders.js";

const customer = (id, email, hasAccount) => ({ id, email, has_account: hasAccount });
const order = (id, customerId, email) => ({ id, customer_id: customerId, email });

test("single guest with no registered row is not flagged", () => {
  const customers = [customer("cus_1", "a@example.com", false)];
  const orders = [order("order_1", "cus_1", "a@example.com")];
  assert.deepEqual(findOrphanedGuestOrders(customers, orders), []);
});

test("single registered row is not flagged", () => {
  const customers = [customer("cus_1", "a@example.com", true)];
  assert.deepEqual(findOrphanedGuestOrders(customers, []), []);
});

test("guest plus registered pair is flagged with its orders", () => {
  const customers = [
    customer("cus_guest", "a@example.com", false),
    customer("cus_reg", "a@example.com", true),
  ];
  const orders = [
    order("order_1", "cus_guest", "a@example.com"),
    order("order_2", "cus_guest", "a@example.com"),
    order("order_3", "cus_reg", "a@example.com"),
  ];
  const result = findOrphanedGuestOrders(customers, orders);
  assert.equal(result.length, 1);
  assert.equal(result[0].guestCustomerId, "cus_guest");
  assert.equal(result[0].registeredCustomerId, "cus_reg");
  assert.deepEqual(result[0].orderIds.sort(), ["order_1", "order_2"]);
});

test("pair with no orders on guest id returns empty order list", () => {
  const customers = [
    customer("cus_guest", "a@example.com", false),
    customer("cus_reg", "a@example.com", true),
  ];
  const result = findOrphanedGuestOrders(customers, []);
  assert.deepEqual(result[0].orderIds, []);
});

test("email is normalized before grouping", () => {
  const customers = [
    customer("cus_guest", "  A@Example.com ", false),
    customer("cus_reg", "a@example.com", true),
  ];
  const orders = [order("order_1", "cus_guest", "a@example.com")];
  const result = findOrphanedGuestOrders(customers, orders);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].orderIds, ["order_1"]);
});

test("two registered rows sharing email is not this pattern", () => {
  const customers = [
    customer("cus_reg1", "a@example.com", true),
    customer("cus_reg2", "a@example.com", true),
  ];
  assert.deepEqual(findOrphanedGuestOrders(customers, []), []);
});

test("two guest rows sharing email is not this pattern", () => {
  const customers = [
    customer("cus_g1", "a@example.com", false),
    customer("cus_g2", "a@example.com", false),
  ];
  assert.deepEqual(findOrphanedGuestOrders(customers, []), []);
});

test("different emails are separate groups", () => {
  const customers = [
    customer("cus_1", "a@example.com", false),
    customer("cus_2", "b@example.com", true),
  ];
  assert.deepEqual(findOrphanedGuestOrders(customers, []), []);
});

test("empty input returns empty list", () => {
  assert.deepEqual(findOrphanedGuestOrders([], []), []);
});
