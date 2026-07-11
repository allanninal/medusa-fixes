import { test } from "node:test";
import assert from "node:assert/strict";
import { findDuplicateTicks } from "./find-duplicate-ticks.js";

const HOURLY = "0 * * * *";

const execution = (over = {}) => ({
  workflow_id: "job-name",
  transaction_id: "tx_1",
  created_at: "2026-07-10T00:00:00Z",
  ...over,
});

test("no duplicate for a single execution", () => {
  const result = findDuplicateTicks([execution()], HOURLY);
  assert.deepEqual(result, []);
});

test("duplicate when two transactions share a tick", () => {
  const rows = [
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ transaction_id: "tx_2", created_at: "2026-07-10T00:00:02Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].transactionIds.sort(), ["tx_1", "tx_2"]);
});

test("not duplicate when on different ticks", () => {
  const rows = [
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ transaction_id: "tx_2", created_at: "2026-07-10T01:00:00Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY);
  assert.deepEqual(result, []);
});

test("same transaction twice is not a duplicate tick", () => {
  const rows = [
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:01Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY);
  assert.deepEqual(result, []);
});

test("tolerance window still groups slightly offset fires", () => {
  const rows = [
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ transaction_id: "tx_2", created_at: "2026-07-10T00:00:04Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY, 5000);
  assert.equal(result.length, 1);
});

test("three processes produce three transaction ids", () => {
  const rows = [
    execution({ transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ transaction_id: "tx_2", created_at: "2026-07-10T00:00:01Z" }),
    execution({ transaction_id: "tx_3", created_at: "2026-07-10T00:00:02Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY);
  assert.equal(result.length, 1);
  assert.equal(result[0].transactionIds.length, 3);
});

test("different workflow ids are kept independent", () => {
  const rows = [
    execution({ workflow_id: "job-a", transaction_id: "tx_1", created_at: "2026-07-10T00:00:00Z" }),
    execution({ workflow_id: "job-a", transaction_id: "tx_2", created_at: "2026-07-10T00:00:01Z" }),
    execution({ workflow_id: "job-b", transaction_id: "tx_3", created_at: "2026-07-10T00:00:00Z" }),
  ];
  const result = findDuplicateTicks(rows, HOURLY);
  assert.equal(result.length, 1);
});
