import { test } from "node:test";
import assert from "node:assert/strict";
import { pickExpectedLocationId } from "./find-wrong-stock-location.js";

const level = (locationId, stockedQuantity = 10) => ({ location_id: locationId, stocked_quantity: stockedQuantity });

test("single location matches and is not a mismatch", () => {
  const result = pickExpectedLocationId([level("sloc_a")], ["sloc_a"], "sloc_a");
  assert.deepEqual(result, { expectedLocationId: "sloc_a", isMismatch: false });
});

test("multiple channel linked locations picks first match", () => {
  const levels = [level("sloc_b"), level("sloc_a")];
  const result = pickExpectedLocationId(levels, ["sloc_a", "sloc_b"], "sloc_b");
  assert.equal(result.expectedLocationId, "sloc_b");
  assert.equal(result.isMismatch, false);
});

test("reservation at unlinked location is a mismatch", () => {
  const levels = [level("sloc_a")];
  const result = pickExpectedLocationId(levels, ["sloc_a"], "sloc_z");
  assert.deepEqual(result, { expectedLocationId: "sloc_a", isMismatch: true });
});

test("no matching location returns null and no mismatch", () => {
  const levels = [level("sloc_z")];
  const result = pickExpectedLocationId(levels, ["sloc_a"], "sloc_z");
  assert.deepEqual(result, { expectedLocationId: null, isMismatch: false });
});

test("reservation already correct is not flagged", () => {
  const levels = [level("sloc_a"), level("sloc_b")];
  const result = pickExpectedLocationId(levels, ["sloc_a", "sloc_b"], "sloc_a");
  assert.equal(result.isMismatch, false);
});
