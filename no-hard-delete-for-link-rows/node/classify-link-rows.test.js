import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLinkRow } from "./classify-link-rows.js";

const row = (over = {}) => ({ leftId: "prod_1", rightId: "sc_1", deletedAt: null, ...over });

test("ok when both parents live", () => {
  assert.equal(classifyLinkRow(row(), new Set(["prod_1"]), new Set(["sc_1"])), "ok");
});

test("orphan dangling when left parent gone", () => {
  const result = classifyLinkRow(row({ leftId: "prod_999" }), new Set(["prod_1"]), new Set(["sc_1"]));
  assert.equal(result, "orphan_dangling");
});

test("orphan dangling when right parent gone", () => {
  const result = classifyLinkRow(row({ rightId: "sc_999" }), new Set(["prod_1"]), new Set(["sc_1"]));
  assert.equal(result, "orphan_dangling");
});

test("orphan dangling when both parents gone", () => {
  const result = classifyLinkRow(row({ leftId: "prod_999", rightId: "sc_999" }), new Set(["prod_1"]), new Set(["sc_1"]));
  assert.equal(result, "orphan_dangling");
});

test("orphan soft deleted even when parents live", () => {
  const r = row({ deletedAt: "2026-07-01T00:00:00Z" });
  assert.equal(classifyLinkRow(r, new Set(["prod_1"]), new Set(["sc_1"])), "orphan_soft_deleted");
});

test("orphan soft deleted when parents also gone", () => {
  const r = row({ leftId: "prod_999", deletedAt: "2026-07-01T00:00:00Z" });
  assert.equal(classifyLinkRow(r, new Set(["prod_1"]), new Set(["sc_1"])), "orphan_soft_deleted");
});

test("empty live sets flags every row as dangling", () => {
  assert.equal(classifyLinkRow(row(), new Set(), new Set()), "orphan_dangling");
});
