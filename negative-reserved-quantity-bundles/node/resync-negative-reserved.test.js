import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReservedQuantityDrift } from "./resync-negative-reserved.js";

const reservations = (...quantities) => quantities.map((q) => ({ quantity: q }));

test("no resync when stored matches live sum", () => {
  const result = computeReservedQuantityDrift(5, reservations(2, 3));
  assert.deepEqual(result, {
    computedReserved: 5,
    drift: 0,
    isNegativeAnomaly: false,
    needsResync: false,
  });
});

test("negative stored is flagged even if it matches a negative sum", () => {
  const result = computeReservedQuantityDrift(-3, reservations());
  assert.equal(result.isNegativeAnomaly, true);
  assert.equal(result.needsResync, true);
  assert.equal(result.computedReserved, 0);
  assert.equal(result.drift, -3);
});

test("positive drift is flagged", () => {
  const result = computeReservedQuantityDrift(9, reservations(2, 2));
  assert.equal(result.computedReserved, 4);
  assert.equal(result.drift, 5);
  assert.equal(result.isNegativeAnomaly, false);
  assert.equal(result.needsResync, true);
});

test("negative drift is flagged", () => {
  const result = computeReservedQuantityDrift(1, reservations(3, 3));
  assert.equal(result.computedReserved, 6);
  assert.equal(result.drift, -5);
  assert.equal(result.needsResync, true);
});

test("empty reservations with zero stored needs no resync", () => {
  const result = computeReservedQuantityDrift(0, reservations());
  assert.equal(result.needsResync, false);
  assert.equal(result.isNegativeAnomaly, false);
});

test("bundle multiplier mismatch example", () => {
  // required_quantity 3, allocate-items reserved 2 orders worth (6), but
  // fulfillment only released 1x per order, leaving reserved_quantity at -3.
  const result = computeReservedQuantityDrift(-3, reservations(6));
  assert.equal(result.isNegativeAnomaly, true);
  assert.equal(result.computedReserved, 6);
  assert.equal(result.drift, -9);
  assert.equal(result.needsResync, true);
});
