import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLinkOrphan } from "./find-orphaned-link-rows.js";

const linkRow = (over = {}) => ({ deleted_at: null, ...over });

test("healthy when both sides exist", () => {
  assert.equal(classifyLinkOrphan(linkRow(), true, true), "HEALTHY");
});

test("already deleted when deleted_at is set", () => {
  const row = linkRow({ deleted_at: "2026-07-01T00:00:00Z" });
  assert.equal(classifyLinkOrphan(row, true, true), "ALREADY_DELETED");
  assert.equal(classifyLinkOrphan(row, false, false), "ALREADY_DELETED");
});

test("orphan left when only left is missing", () => {
  assert.equal(classifyLinkOrphan(linkRow(), false, true), "ORPHAN_LEFT");
});

test("orphan right when only right is missing", () => {
  assert.equal(classifyLinkOrphan(linkRow(), true, false), "ORPHAN_RIGHT");
});

test("orphan both when neither side exists", () => {
  assert.equal(classifyLinkOrphan(linkRow(), false, false), "ORPHAN_BOTH");
});

test("already deleted takes priority over orphan state", () => {
  const row = linkRow({ deleted_at: "2026-01-01T00:00:00Z" });
  assert.equal(classifyLinkOrphan(row, false, true), "ALREADY_DELETED");
});
