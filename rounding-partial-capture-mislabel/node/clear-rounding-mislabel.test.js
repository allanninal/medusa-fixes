import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCaptureDelta, currencyDecimalDigits } from "./clear-rounding-mislabel.js";

test("sub-cent remainder is cleared", () => {
  const result = classifyCaptureDelta(9.9946, 9.99, 2);
  assert.equal(result.action, "clear");
  assert.equal(result.isRoundingArtifact, true);
  assert.equal(Math.round(result.delta * 10000) / 10000, 0.0046);
});

test("real outstanding balance is flagged", () => {
  const result = classifyCaptureDelta(10.0, 9.5, 2);
  assert.equal(result.action, "flag");
  assert.equal(result.isRoundingArtifact, false);
});

test("fully captured needs no action", () => {
  const result = classifyCaptureDelta(10.0, 10.0, 2);
  assert.equal(result.action, "none");
  assert.equal(result.delta, 0);
});

test("overcaptured needs no action", () => {
  const result = classifyCaptureDelta(10.0, 10.01, 2);
  assert.equal(result.action, "none");
});

test("delta exactly at minor unit is flagged not cleared", () => {
  const result = classifyCaptureDelta(10.01, 10.0, 2);
  assert.equal(result.action, "flag");
});

test("zero decimal currency scales minor unit", () => {
  // JPY has no decimal places, so its minor unit is 1, not 0.01.
  const result = classifyCaptureDelta(1000.4, 1000, 0);
  assert.equal(result.action, "clear");
});

test("zero decimal currency flags a full unit gap", () => {
  const result = classifyCaptureDelta(1001, 1000, 0);
  assert.equal(result.action, "flag");
});

test("negative delta needs no action", () => {
  const result = classifyCaptureDelta(9.99, 10.0, 2);
  assert.equal(result.action, "none");
  assert.ok(result.delta < 0);
});

test("currencyDecimalDigits treats jpy as zero decimal", () => {
  assert.equal(currencyDecimalDigits("jpy"), 0);
  assert.equal(currencyDecimalDigits("JPY"), 0);
  assert.equal(currencyDecimalDigits("usd"), 2);
});
