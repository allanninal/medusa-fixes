import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateCustomerGroups } from "./detect-duplicate-customers.js";

const customer = (id, email, hasAccount) => ({ id, email, has_account: hasAccount });

test("single guest is not a duplicate", () => {
  const result = findDuplicateCustomerGroups([customer("cus_1", "a@example.com", false)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].isDuplicate, false);
  assert.equal(result[0].guestId, "cus_1");
  assert.equal(result[0].registeredId, null);
});

test("single registered is not a duplicate", () => {
  const result = findDuplicateCustomerGroups([customer("cus_1", "a@example.com", true)]);
  assert.equal(result[0].isDuplicate, false);
  assert.equal(result[0].registeredId, "cus_1");
  assert.equal(result[0].guestId, null);
});

test("guest plus registered is flagged as duplicate", () => {
  const rows = [
    customer("cus_guest", "a@example.com", false),
    customer("cus_reg", "a@example.com", true),
  ];
  const result = findDuplicateCustomerGroups(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].isDuplicate, true);
  assert.equal(result[0].guestId, "cus_guest");
  assert.equal(result[0].registeredId, "cus_reg");
});

test("email is normalized before grouping", () => {
  const rows = [
    customer("cus_guest", "  A@Example.com ", false),
    customer("cus_reg", "a@example.com", true),
  ];
  const result = findDuplicateCustomerGroups(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].email, "a@example.com");
  assert.equal(result[0].isDuplicate, true);
});

test("two registered rows are not this pattern", () => {
  const rows = [
    customer("cus_reg1", "a@example.com", true),
    customer("cus_reg2", "a@example.com", true),
  ];
  const result = findDuplicateCustomerGroups(rows);
  assert.equal(result[0].isDuplicate, false);
});

test("two guest rows are not this pattern", () => {
  const rows = [
    customer("cus_g1", "a@example.com", false),
    customer("cus_g2", "a@example.com", false),
  ];
  const result = findDuplicateCustomerGroups(rows);
  assert.equal(result[0].isDuplicate, false);
});

test("different emails are separate groups", () => {
  const rows = [
    customer("cus_1", "a@example.com", false),
    customer("cus_2", "b@example.com", true),
  ];
  const result = findDuplicateCustomerGroups(rows);
  assert.equal(result.length, 2);
  assert.equal(result.every((r) => r.isDuplicate === false), true);
});

test("empty input returns empty list", () => {
  assert.deepEqual(findDuplicateCustomerGroups([]), []);
});
