import { test } from "node:test";
import assert from "node:assert/strict";
import { findDanglingLinks } from "./find-dangling-links.js";

test("no dangling rows when all products are live", () => {
  const live = new Set(["prod_1", "prod_2"]);
  const rows = [{ id: "l1", product_id: "prod_1" }, { id: "l2", product_id: "prod_2" }];
  assert.deepEqual(findDanglingLinks(live, rows), []);
});

test("finds the single dangling row", () => {
  const live = new Set(["prod_1", "prod_2"]);
  const rows = [{ id: "l1", product_id: "prod_1" }, { id: "l2", product_id: "prod_999" }];
  assert.deepEqual(findDanglingLinks(live, rows), [{ id: "l2", product_id: "prod_999" }]);
});

test("finds multiple dangling rows", () => {
  const live = new Set(["prod_1"]);
  const rows = [
    { id: "l1", product_id: "prod_1" },
    { id: "l2", product_id: "prod_404" },
    { id: "l3", product_id: "prod_405" },
  ];
  const result = findDanglingLinks(live, rows);
  assert.deepEqual(new Set(result.map((r) => r.id)), new Set(["l2", "l3"]));
});

test("empty link rows returns empty", () => {
  assert.deepEqual(findDanglingLinks(new Set(["prod_1"]), []), []);
});

test("empty live set flags every row", () => {
  const rows = [{ id: "l1", product_id: "prod_1" }, { id: "l2", product_id: "prod_2" }];
  assert.equal(findDanglingLinks(new Set(), rows).length, 2);
});

test("preserves row order of input", () => {
  const live = new Set(["prod_1"]);
  const rows = [
    { id: "l3", product_id: "prod_999" },
    { id: "l1", product_id: "prod_1" },
    { id: "l2", product_id: "prod_998" },
  ];
  const result = findDanglingLinks(live, rows);
  assert.deepEqual(result.map((r) => r.id), ["l3", "l2"]);
});
