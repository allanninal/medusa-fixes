import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateHandles } from "./find-duplicate-handles.js";

const product = (over = {}) => ({
  id: "prod_1",
  handle: "a-shirt",
  title: "A Shirt",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("no duplicates returns empty list", () => {
  const products = [product({ id: "prod_1", handle: "a-shirt" }), product({ id: "prod_2", handle: "b-shirt" })];
  assert.deepEqual(findDuplicateHandles(products), []);
});

test("two products sharing a handle are grouped", () => {
  const products = [
    product({ id: "prod_1", handle: "a-shirt", created_at: "2026-01-02T00:00:00Z" }),
    product({ id: "prod_2", handle: "a-shirt", created_at: "2026-01-01T00:00:00Z" }),
  ];
  const groups = findDuplicateHandles(products);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].handle, "a-shirt");
});

test("group is sorted oldest first", () => {
  const products = [
    product({ id: "prod_new", handle: "a-shirt", created_at: "2026-01-05T00:00:00Z" }),
    product({ id: "prod_old", handle: "a-shirt", created_at: "2026-01-01T00:00:00Z" }),
  ];
  const groups = findDuplicateHandles(products);
  const idsInOrder = groups[0].products.map((p) => p.id);
  assert.deepEqual(idsInOrder, ["prod_old", "prod_new"]);
});

test("three way collision is one group of three", () => {
  const products = [
    product({ id: "prod_1", handle: "a-shirt", created_at: "2026-01-01T00:00:00Z" }),
    product({ id: "prod_2", handle: "a-shirt", created_at: "2026-01-02T00:00:00Z" }),
    product({ id: "prod_3", handle: "a-shirt", created_at: "2026-01-03T00:00:00Z" }),
  ];
  const groups = findDuplicateHandles(products);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].products.length, 3);
});

test("unrelated products do not appear in any group", () => {
  const products = [
    product({ id: "prod_1", handle: "a-shirt", created_at: "2026-01-01T00:00:00Z" }),
    product({ id: "prod_2", handle: "a-shirt", created_at: "2026-01-02T00:00:00Z" }),
    product({ id: "prod_3", handle: "unique-hat", created_at: "2026-01-03T00:00:00Z" }),
  ];
  const groups = findDuplicateHandles(products);
  assert.equal(groups.length, 1);
  const allIds = groups[0].products.map((p) => p.id);
  assert.equal(allIds.includes("prod_3"), false);
});

test("missing created_at does not crash sort", () => {
  const products = [
    product({ id: "prod_1", handle: "a-shirt", created_at: undefined }),
    product({ id: "prod_2", handle: "a-shirt", created_at: "2026-01-01T00:00:00Z" }),
  ];
  const groups = findDuplicateHandles(products);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].products.length, 2);
});
