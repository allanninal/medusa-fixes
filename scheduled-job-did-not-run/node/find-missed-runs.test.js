import { test } from "node:test";
import assert from "node:assert/strict";
import { findMissedRuns } from "./find-missed-runs.js";

const NOW = new Date("2026-07-10T00:00:00Z");
const HOURLY = "0 * * * *";

const record = (over = {}) => ({
  id: "plist_1",
  lastRunAt: new Date("2026-07-09T23:00:00Z"),
  ...over,
});

test("not missed when last run is recent", () => {
  const result = findMissedRuns([record()], HOURLY, NOW);
  assert.deepEqual(result, []);
});

test("missed when last run is far in the past", () => {
  const old = record({ lastRunAt: new Date("2026-07-09T20:00:00Z") });
  const result = findMissedRuns([old], HOURLY, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "plist_1");
});

test("missing last run is always missed", () => {
  const neverRun = record({ lastRunAt: null });
  const result = findMissedRuns([neverRun], HOURLY, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "plist_1");
});

test("handles multiple records independently and sorts by missedByMs desc", () => {
  const recent = record({ id: "plist_recent", lastRunAt: new Date("2026-07-09T23:00:00Z") });
  const worst = record({ id: "plist_worst", lastRunAt: new Date("2026-07-08T00:00:00Z") });
  const mid = record({ id: "plist_mid", lastRunAt: new Date("2026-07-09T18:00:00Z") });
  const result = findMissedRuns([recent, worst, mid], HOURLY, NOW);
  assert.deepEqual(result.map((r) => r.id), ["plist_worst", "plist_mid"]);
});

test("grace multiplier widens the allowed gap", () => {
  const borderline = record({ lastRunAt: new Date("2026-07-09T21:00:00Z") });
  const strict = findMissedRuns([borderline], HOURLY, NOW, 1.0);
  const loose = findMissedRuns([borderline], HOURLY, NOW, 5.0);
  assert.equal(strict.length, 1);
  assert.equal(loose.length, 0);
});
