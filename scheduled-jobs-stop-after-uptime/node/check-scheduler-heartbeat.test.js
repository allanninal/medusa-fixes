import { test } from "node:test";
import assert from "node:assert/strict";
import { isSchedulerStalled } from "./check-scheduler-heartbeat.js";

const NOW = new Date("2026-07-10T00:00:00Z");
const EVERY_MINUTE = "* * * * *";

test("not stalled when heartbeat is recent", () => {
  const lastRun = new Date(NOW.getTime() - 30_000);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 3), false);
});

test("not stalled right at the tolerance boundary", () => {
  // 60_000ms interval * 3 tolerance = 180s; 179s of silence is still healthy
  const lastRun = new Date(NOW.getTime() - 179_000);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 3), false);
});

test("stalled after twenty minutes of silence with default tolerance", () => {
  const lastRun = new Date(NOW.getTime() - 20 * 60_000);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 3), true);
});

test("higher tolerance delays the stalled verdict", () => {
  const lastRun = new Date(NOW.getTime() - 4 * 60_000);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 3), true);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 10), false);
});

test("works with a five minute schedule", () => {
  const everyFive = "*/5 * * * *";
  const healthy = new Date(NOW.getTime() - 6 * 60_000);
  const stalled = new Date(NOW.getTime() - 20 * 60_000);
  assert.equal(isSchedulerStalled(healthy, NOW, everyFive, 3), false);
  assert.equal(isSchedulerStalled(stalled, NOW, everyFive, 3), true);
});

test("exactly at tolerance boundary is not stalled", () => {
  // Interval is 60_000ms, tolerance 3 -> boundary is exactly 180s.
  // isSchedulerStalled uses strict greater-than, so exactly at the
  // boundary should still read as healthy.
  const lastRun = new Date(NOW.getTime() - 180_000);
  assert.equal(isSchedulerStalled(lastRun, NOW, EVERY_MINUTE, 3), false);
});
