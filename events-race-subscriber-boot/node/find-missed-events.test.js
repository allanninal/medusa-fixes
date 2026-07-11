import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissedEventWindows } from "./find-missed-events.js";

const LOADER_DONE_AT_MS = 1_000_000;

const entry = (over = {}) => ({ event: "order.placed", atMs: 900_000, ...over });

test("event before loader done is missed", () => {
  const result = findMissedEventWindows([entry()], LOADER_DONE_AT_MS);
  assert.equal(result.length, 1);
  assert.equal(result[0].event, "order.placed");
  assert.equal(result[0].gapMs, 100_000);
});

test("event after loader done is not missed", () => {
  const result = findMissedEventWindows([entry({ atMs: 1_100_000 })], LOADER_DONE_AT_MS);
  assert.deepEqual(result, []);
});

test("event exactly at loader done is not missed", () => {
  const result = findMissedEventWindows([entry({ atMs: LOADER_DONE_AT_MS })], LOADER_DONE_AT_MS);
  assert.deepEqual(result, []);
});

test("handles multiple events independently", () => {
  const early = entry({ event: "cart.completed", atMs: 500_000 });
  const late = entry({ event: "customer.created", atMs: 1_200_000 });
  const result = findMissedEventWindows([entry(), early, late], LOADER_DONE_AT_MS);
  assert.deepEqual(result.map((r) => r.event), ["order.placed", "cart.completed"]);
});

test("empty boot log returns empty", () => {
  assert.deepEqual(findMissedEventWindows([], LOADER_DONE_AT_MS), []);
});

test("gapMs matches the difference exactly", () => {
  const result = findMissedEventWindows([entry({ atMs: 250_000 })], LOADER_DONE_AT_MS);
  assert.equal(result[0].gapMs, 750_000);
});
