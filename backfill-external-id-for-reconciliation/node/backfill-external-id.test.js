import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExternalIdBackfill } from "./backfill-external-id.js";

const order = (over = {}) => ({
  id: "order_1",
  display_id: 1042,
  metadata: null,
  created_at: "2026-07-01T00:00:00Z",
  email: "buyer@example.com",
  total: 150.0,
  ...over,
});

const candidate = (over = {}) => ({
  legacyId: "LEG-1042",
  display_id: 1042,
  email: "buyer@example.com",
  total: 150.0,
  created_at: "2026-07-01T00:00:00Z",
  ...over,
});

test("skip when already has external_id", () => {
  const o = order({ metadata: { external_id: "LEG-9999" } });
  const result = decideExternalIdBackfill(o, [candidate()]);
  assert.equal(result.action, "skip_has_id");
});

test("apply on exact display_id match", () => {
  const result = decideExternalIdBackfill(order(), [candidate()]);
  assert.equal(result.action, "apply");
  assert.equal(result.external_id, "LEG-1042");
});

test("flag no match when display_id absent from export", () => {
  const result = decideExternalIdBackfill(order(), [candidate({ display_id: 9999 })]);
  assert.equal(result.action, "flag_no_match");
});

test("flag ambiguous when multiple display_id matches", () => {
  const result = decideExternalIdBackfill(order(), [
    candidate({ legacyId: "LEG-A" }),
    candidate({ legacyId: "LEG-B" }),
  ]);
  assert.equal(result.action, "flag_ambiguous");
});

test("falls back to fuzzy match without display_id", () => {
  const o = order({ display_id: null });
  const result = decideExternalIdBackfill(o, [candidate({ display_id: null })]);
  assert.equal(result.action, "apply");
  assert.equal(result.external_id, "LEG-1042");
});

test("fuzzy match rejects total outside epsilon", () => {
  const o = order({ display_id: null });
  const result = decideExternalIdBackfill(o, [candidate({ display_id: null, total: 200.0 })]);
  assert.equal(result.action, "flag_no_match");
});

test("fuzzy match rejects created_at outside day window", () => {
  const o = order({ display_id: null });
  const result = decideExternalIdBackfill(o, [
    candidate({ display_id: null, created_at: "2026-07-10T00:00:00Z" }),
  ]);
  assert.equal(result.action, "flag_no_match");
});

test("fuzzy match rejects missing email", () => {
  const o = order({ display_id: null, email: undefined });
  const result = decideExternalIdBackfill(o, [candidate({ display_id: null })]);
  assert.equal(result.action, "flag_no_match");
});

test("empty string external_id is treated as missing", () => {
  const o = order({ metadata: { external_id: "" } });
  const result = decideExternalIdBackfill(o, [candidate()]);
  assert.equal(result.action, "apply");
});

test("no candidates at all is no match", () => {
  const result = decideExternalIdBackfill(order(), []);
  assert.equal(result.action, "flag_no_match");
});
