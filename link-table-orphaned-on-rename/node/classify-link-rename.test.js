import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLinkRename } from "./classify-link-rename.js";

test("no orphans when all tables defined", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_article_post"],
    rowCounts: { product_product_article_post: 42 },
  });
  assert.deepEqual(result, []);
});

test("orphaned when table undefined and has rows", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_article_post", "product_product_blog_post"],
    rowCounts: { product_product_article_post: 10, product_product_blog_post: 87 },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].orphanedTable, "product_product_blog_post");
  assert.equal(result[0].rowCount, 87);
});

test("not orphaned when undefined table is empty", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_article_post", "product_product_blog_post"],
    rowCounts: { product_product_article_post: 10, product_product_blog_post: 0 },
  });
  assert.deepEqual(result, []);
});

test("not orphaned when undefined table missing from row counts", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_article_post", "product_product_blog_post"],
    rowCounts: { product_product_article_post: 10 },
  });
  assert.deepEqual(result, []);
});

test("suspected rename of uses shared segments", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_blog_post"],
    rowCounts: { product_product_blog_post: 5 },
  });
  assert.equal(result[0].suspectedRenameOf, "product_product_article_post");
});

test("suspected rename of is null with no overlap", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["sales_channel_stock_location"],
    existingDbTables: ["product_product_blog_post"],
    rowCounts: { product_product_blog_post: 5 },
  });
  assert.equal(result[0].suspectedRenameOf, null);
});

test("multiple orphans reported independently", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post"],
    existingDbTables: ["product_product_blog_post", "product_variant_old_inventory_item"],
    rowCounts: { product_product_blog_post: 3, product_variant_old_inventory_item: 9 },
  });
  const orphanedNames = new Set(result.map((row) => row.orphanedTable));
  assert.deepEqual(orphanedNames, new Set(["product_product_blog_post", "product_variant_old_inventory_item"]));
});

test("picks best overlap among multiple candidates", () => {
  const result = classifyLinkRename({
    definedLinkTables: ["product_product_article_post", "product_variant_article_post"],
    existingDbTables: ["product_product_blog_post"],
    rowCounts: { product_product_blog_post: 5 },
  });
  assert.equal(result[0].suspectedRenameOf, "product_product_article_post");
});
